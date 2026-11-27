// Writes a file set into a workspace and closes it again, so the workbench can open it the
// ordinary way. The GitHub importer and share links use it; template seeding can too.
//
// A workspace being written carries a marker (`state: "importing"` in /.sprockt/workspace.json),
// written first and cleared as the last step, after the final flush. A workspace that still has
// the marker was cut off; the landing page shows it with Retry and Delete (see
// IncompleteImport.tsx). Sprockt never deletes a workspace on its own. The one exception is
// a cancel or failure in the same page: then this call deletes the workspace it created itself,
// one whose id it reserved and found empty. If that delete is busy or fails, the marker stays.
import { withWorkspaceMetaLock } from "../workspace/hint";
import { newWorkspaceId, PROJECT_ROOT, storageName } from "../workspace/paths";
import {
  INCOMPLETE,
  readMetaFile,
  WORKSPACE_META_PATH,
  writeMetaFile,
  type MetaFilesystem,
  type WorkspaceMeta,
} from "./metadata";

export interface WorkspaceWriterFilesystem extends MetaFilesystem {
  listFiles(path: string): Promise<string[]>;
  remove(path: string): Promise<unknown>;
}

/** The part of a session this needs; `openWorkspace` from `workspace/session` or a lightweight backend provides it. */
export interface WorkspaceWriter {
  readonly files: {
    writeMany(files: Readonly<Record<string, string | Uint8Array>>): Promise<void>;
  };
  readonly runtime: {
    readonly filesystem: WorkspaceWriterFilesystem;
  };
  dispose(): Promise<void>;
}

export interface NewWorkspaceDeps {
  readonly open: (id: string, signal?: AbortSignal) => Promise<WorkspaceWriter>;
  /** Deletes the storage behind a workspace; Waffle answers "deleted", "missing" or "busy". */
  readonly remove: (storage: string) => Promise<unknown>;
  /** Whether storage for this name already exists. */
  readonly exists: (storage: string) => Promise<boolean>;
  readonly newId?: () => string;
}

export interface CreateOptions {
  readonly signal?: AbortSignal;
  /** Rewrite this incomplete workspace (Retry) instead of creating a new one. */
  readonly into?: string;
}

/** The id was taken, or the workspace held files this call did not write. Nothing was changed. */
export class WorkspaceIdTakenError extends Error {}

/** Retry was asked for a workspace that is not an unfinished import. Nothing was changed. */
export class NotIncompleteError extends Error {}

/** Ten random characters rarely collide; this many tries makes it practically impossible. */
const ID_ATTEMPTS = 8;
/** Stale files removed at once when retrying an unfinished import, to stay under Waffle's in-flight RPC quota. */
const REMOVE_BATCH = 8;

async function removeInBatches(
  filesystem: WorkspaceWriterFilesystem,
  paths: readonly string[],
  signal: AbortSignal | undefined,
): Promise<void> {
  for (let start = 0; start < paths.length; start += REMOVE_BATCH) {
    signal?.throwIfAborted();
    // Settle each batch before starting the next so cleanup never saturates the filesystem RPC queue.
    // oxlint-disable-next-line no-await-in-loop
    const outcomes = await Promise.allSettled(
      paths.slice(start, start + REMOVE_BATCH).map(async (path) => filesystem.remove(path)),
    );
    const failed = outcomes.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );
    if (failed) throw failed.reason;
  }
}

async function unusedId(deps: NewWorkspaceDeps): Promise<string> {
  const newId = deps.newId ?? newWorkspaceId;
  const candidates = Array.from({ length: ID_ATTEMPTS }, () => newId());
  const taken = await Promise.all(candidates.map((id) => deps.exists(storageName(id))));
  const id = candidates.find((_, index) => !taken[index]);
  if (!id) throw new WorkspaceIdTakenError("Could not find an unused workspace id");
  return id;
}

/**
 * Writes `files` and `meta` into a new workspace (or, with `into`, back into an unfinished
 * one) and returns its id once every byte is flushed and the marker is cleared.
 */
export async function createWorkspaceWithFiles(
  files: Readonly<Record<string, string | Uint8Array>>,
  meta: WorkspaceMeta,
  deps: NewWorkspaceDeps,
  options: CreateOptions = {},
): Promise<string> {
  options.signal?.throwIfAborted();
  if (options.into) return rewriteIncomplete(options.into, files, meta, deps, options.signal);
  const id = await unusedId(deps);
  // A failed open owns nothing: whatever it left is not ours to delete.
  const session = await deps.open(id, options.signal);
  // Ownership is proven by an empty project (raw listing, so node_modules and .git count) and
  // no metadata yet. Checked even after a cancel, so a workspace someone else created is never
  // deleted.
  const owned = await isUntouched(session).catch(() => false);
  if (!owned) {
    await close(session);
    throw new WorkspaceIdTakenError(`Workspace ${id} is already in use`);
  }
  return fill(id, session, files, meta, { deps, signal: options.signal, created: true });
}

async function rewriteIncomplete(
  id: string,
  files: Readonly<Record<string, string | Uint8Array>>,
  meta: WorkspaceMeta,
  deps: NewWorkspaceDeps,
  signal: AbortSignal | undefined,
): Promise<string> {
  // Serialize the entire retry under the workspace metadata lock so two concurrent retries can
  // never both pass the INCOMPLETE check and interleave cleanup/writes.
  return withWorkspaceMetaLock(
    id,
    async () => {
      signal?.throwIfAborted();
      const session = await deps.open(id, signal);
      const current = await readMetaFile(session.runtime.filesystem).catch(() => undefined);
      if (current?.state !== INCOMPLETE) {
        await close(session);
        throw new NotIncompleteError(`Workspace ${id} is not an unfinished import`);
      }
      // Clear what the cut-off attempt wrote; the marker lives outside the project and stays.
      try {
        const stale = await session.runtime.filesystem.listFiles(PROJECT_ROOT);
        await removeInBatches(session.runtime.filesystem, stale, signal);
      } catch (error) {
        await close(session);
        throw error;
      }
      return fill(id, session, files, meta, { deps, signal, created: false, locked: true });
    },
    signal,
  );
}

interface FillContext {
  readonly deps: NewWorkspaceDeps;
  readonly signal: AbortSignal | undefined;
  /** Whether this call created the workspace, and so may delete it after a failure. */
  readonly created: boolean;
  /** Whether the caller already holds `withWorkspaceMetaLock(id)`. */
  readonly locked?: boolean;
}

async function fill(
  id: string,
  session: WorkspaceWriter,
  files: Readonly<Record<string, string | Uint8Array>>,
  meta: WorkspaceMeta,
  context: FillContext,
): Promise<string> {
  const { state: _ignored, ...complete } = meta;
  try {
    // New workspaces always write the INCOMPLETE marker before checking cancellation so a busy
    // rollback still exposes Retry/Delete. Retries already hold the lock and marker on disk.
    await writeMeta(
      id,
      session,
      { ...complete, state: INCOMPLETE },
      context.created ? undefined : context.signal,
      context.locked === true,
    );
    context.signal?.throwIfAborted();
    await session.files.writeMany(files);
    await session.runtime.filesystem.flush();
    context.signal?.throwIfAborted();
    await writeMeta(id, session, complete, context.signal, context.locked === true);
  } catch (error) {
    await close(session);
    // A busy or failed delete leaves the marker, and the landing page offers Retry and Delete.
    if (context.created) await context.deps.remove(storageName(id)).catch(() => undefined);
    throw error;
  }
  // Every byte is flushed and the marker is cleared: the workspace is complete even if closing fails.
  await close(session);
  return id;
}

async function isUntouched(session: WorkspaceWriter): Promise<boolean> {
  const [paths, meta] = await Promise.all([
    session.runtime.filesystem.listFiles(PROJECT_ROOT),
    session.runtime.filesystem.readFile(WORKSPACE_META_PATH),
  ]);
  return paths.length === 0 && meta === undefined;
}

function writeMeta(
  id: string,
  session: WorkspaceWriter,
  meta: WorkspaceMeta,
  signal?: AbortSignal,
  alreadyLocked = false,
): Promise<void> {
  const write = async () => {
    signal?.throwIfAborted();
    await writeMetaFile(session.runtime.filesystem, meta);
  };
  return alreadyLocked ? write() : withWorkspaceMetaLock(id, write, signal);
}

async function close(session: WorkspaceWriter): Promise<void> {
  await session.dispose().catch(() => undefined);
}
