// Workspace seeding (delegated to shared `createWorkspaceWithFiles`) and atomic non-stealing rename.
// Uses Waffle's IndexedDBStorage + PersistentBackend under a single exclusive lock
// (`whenBusy: "ifAvailable"`), so another tab's ownership is never stolen and waffle/runtime.ts stays unloaded.
import { IndexedDBStorage, IndexedDBStorageBusyError } from "waffle/fs/indexeddb";
import { PersistentBackend } from "waffle/fs/persistent";
import {
  createWorkspaceWithFiles,
  NotIncompleteError,
  WorkspaceIdTakenError,
  type NewWorkspaceDeps,
  type WorkspaceWriter,
} from "../importer/new-workspace";
import { deleteIdleWorkspaceStorage, openExistingDatabase } from "../landing/storage-discovery";
import { projectPath, storageName } from "../workspace/paths";
import { BLANK_TEMPLATE, findTemplate, type TemplateId } from "./catalog";
import {
  createWorkspaceMeta,
  normalizeWorkspaceName,
  updateWorkspaceMetaName,
  WORKSPACE_META_DIR,
  WORKSPACE_META_PATH,
  type WorkspaceMeta,
} from "./workspace-meta";

export { NotIncompleteError, WorkspaceIdTakenError };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const EMPTY_BYTES = new Uint8Array();

class WorkspaceBusyError extends Error {
  constructor(id: string) {
    super(`Workspace ${id} is open in another tab`);
    this.name = "WorkspaceBusyError";
  }
}

function parentDirectory(path: string): string | undefined {
  const slash = path.lastIndexOf("/");
  return slash > 0 ? path.slice(0, slash) : undefined;
}

async function writeAbsoluteFile(
  backend: PersistentBackend,
  path: string,
  content: string | Uint8Array,
): Promise<void> {
  const parent = parentDirectory(path);
  if (parent) {
    await backend.prepare("mkdirp", [parent]);
    backend.execute("mkdirp", [parent], EMPTY_BYTES);
  }
  const bytes = typeof content === "string" ? encoder.encode(content) : content;
  await backend.prepare("writeFile", [path, false, false]);
  backend.execute("writeFile", [path, false, false], bytes);
}

function createBackendWriter(backend: PersistentBackend): WorkspaceWriter {
  return {
    files: {
      async writeMany(files) {
        for (const [relativePath, content] of Object.entries(files)) {
          const absolute = projectPath(relativePath);
          // oxlint-disable-next-line no-await-in-loop
          await writeAbsoluteFile(backend, absolute, content);
        }
      },
    },
    runtime: {
      filesystem: {
        async listFiles(path: string): Promise<string[]> {
          return backend.execute("listFiles", [path], EMPTY_BYTES) as string[];
        },
        async mkdirp(path: string): Promise<void> {
          await backend.prepare("mkdirp", [path]);
          backend.execute("mkdirp", [path], EMPTY_BYTES);
        },
        async readFile(path: string): Promise<Uint8Array | undefined> {
          await backend.prepare("readFile", [path]);
          return backend.execute("readFile", [path], EMPTY_BYTES) as Uint8Array | undefined;
        },
        async writeFile(path: string, content: string | Uint8Array): Promise<void> {
          await writeAbsoluteFile(backend, path, content);
        },
        async remove(path: string): Promise<unknown> {
          await backend.prepare("remove", [path]);
          return backend.execute("remove", [path], EMPTY_BYTES);
        },
        async flush(): Promise<void> {
          await backend.flush();
        },
      },
    },
    async dispose(): Promise<void> {
      await backend.retireFenced();
    },
  };
}

export interface OpenRenameOptions {
  readonly requireExisting: boolean;
  readonly signal?: AbortSignal;
}

export interface RenameWorkspaceDeps {
  readonly open: (id: string, options: OpenRenameOptions) => Promise<WorkspaceWriter | "busy" | "missing">;
}

async function openBrowserWriter(
  id: string,
  options: OpenRenameOptions,
): Promise<WorkspaceWriter | "busy" | "missing"> {
  const name = storageName(id);
  if (options.requireExisting) {
    const existing = await openExistingDatabase(name);
    if (!existing) return "missing";
    existing.close();
  }

  let storage: IndexedDBStorage;
  try {
    storage = await IndexedDBStorage.open(name, {
      whenBusy: "ifAvailable",
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof IndexedDBStorageBusyError) return "busy";
    throw error;
  }

  try {
    const backend = await PersistentBackend.open(storage, {
      intervalMs: 0,
      signal: options.signal,
    });
    if (options.requireExisting && !backend.hasLoadedIndex) {
      await backend.retireFenced();
      return "missing";
    }
    return createBackendWriter(backend);
  } catch (error) {
    await storage.close().catch(() => undefined);
    throw error;
  }
}

async function databaseExists(name: string): Promise<boolean> {
  if (typeof globalThis.indexedDB?.databases !== "function") return false;
  const databases = await globalThis.indexedDB.databases();
  return databases.some((entry) => entry.name === name);
}

const DEFAULT_NEW_WORKSPACE_DEPS: NewWorkspaceDeps = {
  async open(id: string): Promise<WorkspaceWriter> {
    const opened = await openBrowserWriter(id, { requireExisting: false });
    if (opened === "busy") throw new WorkspaceBusyError(id);
    if (opened === "missing") throw new Error(`Workspace ${id} could not be opened`);
    return opened;
  },
  exists: databaseExists,
  remove: deleteIdleWorkspaceStorage,
};

const DEFAULT_RENAME_DEPS: RenameWorkspaceDeps = {
  open: openBrowserWriter,
};

export interface SeedWorkspaceOptions {
  readonly customName?: string;
  readonly signal?: AbortSignal;
}

export interface SeedWorkspaceResult {
  readonly id: string;
  readonly meta: WorkspaceMeta;
}

/**
 * Seeds a starter template into a brand-new workspace using the shared `createWorkspaceWithFiles`
 * helper (fresh id, empty-workspace ownership check, `state: "importing"` marker written first
 * and cleared after final flush, in-page rollback only of its own workspace).
 */
export async function seedWorkspace(
  templateId: TemplateId,
  options: SeedWorkspaceOptions = {},
  deps: NewWorkspaceDeps = DEFAULT_NEW_WORKSPACE_DEPS,
): Promise<SeedWorkspaceResult> {
  const template = findTemplate(templateId) ?? BLANK_TEMPLATE;
  const meta = createWorkspaceMeta({
    name: options.customName ?? template.defaultName,
    template: template.id,
  });
  const id = await createWorkspaceWithFiles(template.files, meta, deps, { signal: options.signal });
  return { id, meta };
}

export type RetrySeedResult =
  | { readonly status: "seeded"; readonly meta: WorkspaceMeta }
  | { readonly status: "already-ready" | "busy" | "missing" };

/**
 * Finishes seeding an unfinished template workspace in place using `createWorkspaceWithFiles(..., { into: id })`.
 * Never steals another tab's lock and refuses to overwrite a finished workspace.
 */
export async function retrySeedWorkspace(
  id: string,
  templateId: string,
  customName?: string,
  deps: NewWorkspaceDeps = DEFAULT_NEW_WORKSPACE_DEPS,
): Promise<RetrySeedResult> {
  const template = findTemplate(templateId) ?? BLANK_TEMPLATE;
  const meta = createWorkspaceMeta({
    name: customName ?? template.defaultName,
    template: template.id,
  });
  try {
    await createWorkspaceWithFiles(template.files, meta, deps, { into: id });
    return { status: "seeded", meta };
  } catch (error) {
    if (error instanceof WorkspaceBusyError) return { status: "busy" };
    if (error instanceof NotIncompleteError) return { status: "already-ready" };
    throw error;
  }
}

export type RenameResult =
  | { readonly status: "renamed"; readonly meta: WorkspaceMeta }
  | { readonly status: "busy" | "missing" | "invalid" };

/**
 * Renames an existing idle workspace under a single non-stealing exclusive lock.
 * Never revokes another tab's ownership and never recreates a deleted workspace.
 */
export async function renameWorkspace(
  id: string,
  nextName: string,
  deps: RenameWorkspaceDeps = DEFAULT_RENAME_DEPS,
): Promise<RenameResult> {
  const normalized = normalizeWorkspaceName(nextName);
  if (!normalized) return { status: "invalid" };

  const opened = await deps.open(id, { requireExisting: true });
  if (opened === "busy" || opened === "missing") return { status: opened };

  try {
    const rawBytes = await opened.runtime.filesystem.readFile(WORKSPACE_META_PATH);
    const rawMeta = rawBytes ? decoder.decode(rawBytes) : undefined;
    const { json, meta } = updateWorkspaceMetaName(rawMeta, normalized);
    await opened.runtime.filesystem.mkdirp(WORKSPACE_META_DIR);
    await opened.runtime.filesystem.writeFile(WORKSPACE_META_PATH, json);
    await opened.runtime.filesystem.flush();
    await opened.dispose();
    return { status: "renamed", meta };
  } catch (error) {
    await opened.dispose().catch(() => undefined);
    throw error;
  }
}
