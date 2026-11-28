// The browser storage dependencies of `createWorkspaceWithFiles` and the hand-off to the
// workbench once a workspace is written. Uses Waffle's IndexedDBStorage + PersistentBackend
// under an exclusive non-stealing lock (`whenBusy: "ifAvailable"`), so creation never attaches
// to another tab's workspace and `waffle/runtime.ts` stays unloaded.
import {
  ExpectedEpochMismatchError,
  IndexedDBStorage,
  IndexedDBStorageBusyError,
  IndexedDBStorageMissingError,
} from "waffle/fs/indexeddb";
import { PersistentBackend } from "waffle/fs/persistent";
import { FilesystemError } from "waffle/fs/protocol";
import { notifyWorkspaceWriterSettled } from "../workspace/hint";
import { isWorkspaceId, PROJECT_ROOT, projectPath, storageName } from "../workspace/paths";
import { replaceRoute } from "./navigation";
import type { NewWorkspaceDeps, WorkspaceWriter } from "./new-workspace";

const encoder = new TextEncoder();
const EMPTY_BYTES = new Uint8Array();

function parentDirectory(path: string): string | undefined {
  const slash = path.lastIndexOf("/");
  return slash > 0 ? path.slice(0, slash) : undefined;
}

function isRetryableDirtyCapacity(error: unknown): boolean {
  return error instanceof FilesystemError && error.errno === 6 && Reflect.get(error, "permanent") === false;
}

async function runBackendOp(
  backend: PersistentBackend,
  operation: string,
  args: unknown[],
  data: Uint8Array = EMPTY_BYTES,
): Promise<unknown> {
  try {
    await backend.prepare(operation, args);
    return backend.execute(operation, args as never, data);
  } catch (error) {
    if (!isRetryableDirtyCapacity(error)) throw error;
    await backend.flush();
    await backend.prepare(operation, args);
    return backend.execute(operation, args as never, data);
  }
}

async function writeAbsoluteFile(
  backend: PersistentBackend,
  path: string,
  content: string | Uint8Array,
): Promise<void> {
  const parent = parentDirectory(path);
  if (parent) await runBackendOp(backend, "mkdirp", [parent]);
  const bytes = typeof content === "string" ? encoder.encode(content) : content;
  await runBackendOp(backend, "writeFile", [path, false, false], bytes);
}

export interface BrowserWriterOptions {
  /**
   * Whether closing this writer notifies same-tab landing subscribers. Background imports/restores
   * default to `true`; foreground landing actions (starter launch, retry, rename) pass `false` so
   * closing their own writer never triggers a competing discovery probe before handoff.
   */
  readonly notifyOnClose?: boolean;
}

async function retireBackend(backend: PersistentBackend, notifyOnClose: boolean): Promise<void> {
  try {
    await backend.retireFenced();
  } finally {
    if (notifyOnClose) notifyWorkspaceWriterSettled();
  }
}

async function closeStorage(storage: IndexedDBStorage, notifyOnClose: boolean): Promise<void> {
  try {
    await storage.close().catch(() => undefined);
  } finally {
    if (notifyOnClose) notifyWorkspaceWriterSettled();
  }
}

function createBackendWriter(backend: PersistentBackend, notifyOnClose: boolean): WorkspaceWriter {
  return {
    files: {
      async writeMany(files) {
        const entries = Object.entries(files).map(
          ([relativePath, content]) => [projectPath(relativePath), content] as const,
        );
        await runBackendOp(backend, "mkdirp", [PROJECT_ROOT]);
        for (const [absolute, content] of entries) {
          // Each file shares one backend instance; writing sequentially keeps dirty pressure bounded.
          // oxlint-disable-next-line no-await-in-loop
          await writeAbsoluteFile(backend, absolute, content);
        }
      },
    },
    runtime: {
      filesystem: {
        async mkdirp(path: string): Promise<void> {
          await runBackendOp(backend, "mkdirp", [path]);
        },
        async readFile(path: string): Promise<Uint8Array | undefined> {
          await backend.prepare("readFile", [path]);
          return backend.execute("readFile", [path], EMPTY_BYTES) as Uint8Array | undefined;
        },
        async writeFile(path: string, content: string | Uint8Array): Promise<void> {
          await writeAbsoluteFile(backend, path, content);
        },
        async remove(path: string): Promise<unknown> {
          return runBackendOp(backend, "remove", [path]);
        },
        async flush(): Promise<void> {
          await backend.flush();
        },
      },
    },
    dispose(): Promise<void> {
      return retireBackend(backend, notifyOnClose);
    },
  };
}

function isInvalidFormatError(error: unknown): boolean {
  return (
    error instanceof Error && error.name === "VfsError" && Reflect.get(error, "code") === "INVALID_VFS_FORMAT"
  );
}

function isCreateCollision(error: unknown): boolean {
  if (error instanceof IndexedDBStorageBusyError) return true;
  if (error instanceof ExpectedEpochMismatchError) return true;
  return isInvalidFormatError(error);
}

/**
 * Atomically creates and claims a brand-new workspace under an exclusive lock.
 * `expectedEpoch: 0` fails with `ExpectedEpochMismatchError` if any Waffle opener has ever
 * allocated an epoch on this database name, even when the workspace holds only empty directories.
 */
export async function createNewBrowserWriter(
  id: string,
  signal?: AbortSignal,
  options: BrowserWriterOptions = {},
): Promise<WorkspaceWriter | "taken"> {
  signal?.throwIfAborted();
  const notifyOnClose = options.notifyOnClose ?? true;
  const name = storageName(id);
  let storage: IndexedDBStorage;
  try {
    // Once IndexedDB opens a new database, finish acquiring the writer so `fill` can flush the
    // incomplete marker before honoring cancellation; otherwise an empty, un-listable DB remains.
    // `whenBusy: "ifAvailable"` never waits on a live writer lock.
    storage = await IndexedDBStorage.open(name, {
      whenBusy: "ifAvailable",
      expectedEpoch: 0,
      epochOwner: "exclusive",
    });
  } catch (error) {
    if (isCreateCollision(error)) return "taken";
    throw error;
  }

  try {
    const backend = await PersistentBackend.open(storage, { intervalMs: 0 });
    if (backend.hasLoadedIndex) {
      await retireBackend(backend, notifyOnClose);
      return "taken";
    }
    return createBackendWriter(backend, notifyOnClose);
  } catch (error) {
    await closeStorage(storage, notifyOnClose);
    throw error;
  }
}

/**
 * Opens an existing workspace under a single non-stealing exclusive lock without creating a
 * missing database (`createIfMissing: false` aborts IDB creation under Waffle's maintenance lock).
 * Returns `"busy"` if another tab holds it, or `"missing"` if absent.
 */
export async function openExistingBrowserWriter(
  id: string,
  signal?: AbortSignal,
  options: BrowserWriterOptions = {},
): Promise<WorkspaceWriter | "busy" | "missing"> {
  signal?.throwIfAborted();
  const notifyOnClose = options.notifyOnClose ?? true;
  const name = storageName(id);
  let storage: IndexedDBStorage;
  try {
    storage = await IndexedDBStorage.open(name, {
      whenBusy: "ifAvailable",
      epochOwner: "exclusive",
      createIfMissing: false,
      signal,
    });
  } catch (error) {
    if (error instanceof IndexedDBStorageBusyError) return "busy";
    if (error instanceof IndexedDBStorageMissingError || isInvalidFormatError(error)) return "missing";
    throw error;
  }

  try {
    const backend = await PersistentBackend.open(storage, { intervalMs: 0, signal });
    if (!backend.hasLoadedIndex) {
      await retireBackend(backend, notifyOnClose);
      return "missing";
    }
    return createBackendWriter(backend, notifyOnClose);
  } catch (error) {
    await closeStorage(storage, notifyOnClose);
    throw error;
  }
}

export function createBrowserWorkspaceDeps(options: BrowserWriterOptions = {}): NewWorkspaceDeps {
  return {
    createNew: (id, signal) => createNewBrowserWriter(id, signal, options),
    openExisting: (id, signal) => openExistingBrowserWriter(id, signal, options),
  };
}

export const browserWorkspaceDeps: NewWorkspaceDeps = createBrowserWorkspaceDeps();

/** Browser deps for foreground landing actions that own their own navigation or explicit refresh. */
export const quietBrowserWorkspaceDeps: NewWorkspaceDeps = createBrowserWorkspaceDeps({
  notifyOnClose: false,
});

/**
 * Opens the finished workspace, unless the visitor left while it was being written. The
 * workspace is complete either way and stays; it is listed on the landing page.
 */
export function openUnlessCancelled(id: string, signal: AbortSignal): void {
  if (!signal.aborted) replaceRoute({ kind: "workspace", id });
}

/** `?into=<id>` on an import URL: Retry of an unfinished import rewrites that workspace. */
export function retryTarget(search: string): string | undefined {
  const into = new URLSearchParams(search).get("into");
  return into && isWorkspaceId(into) ? into : undefined;
}
