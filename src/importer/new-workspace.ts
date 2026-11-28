// Writes a file set into a workspace and closes it again, so the workbench can open it the
// ordinary way. The GitHub importer, share links, and template seeding all use it.
//
// A workspace being written carries a marker (`state: "importing"` in /.sprockt/workspace.json),
// written first and cleared as the last step, after the final flush. A workspace that still has
// the marker was cut off; the landing page shows it with Retry and confirmed Delete. Sprockt
// never deletes a workspace on its own: failure or cancellation closes the writer and leaves
// the incomplete marker intact so Retry or explicit Delete owns cleanup.
import { newWorkspaceId, PROJECT_ROOT } from "../workspace/paths";
import { INCOMPLETE, readMetaFile, writeMetaFile, type MetaFilesystem, type WorkspaceMeta } from "./metadata";

export interface WorkspaceWriterFilesystem extends MetaFilesystem {
  /** Removes a file or directory subtree at `path`; no-op if absent. */
  remove(path: string): Promise<unknown>;
}

/** An exclusively owned writer for one workspace. */
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
  /**
   * Atomically claims a brand-new workspace id under an exclusive lock, returning an owned writer
   * or `"taken"` when storage already exists or another tab holds it.
   */
  readonly createNew: (id: string, signal?: AbortSignal) => Promise<WorkspaceWriter | "taken">;
  /**
   * Opens an existing workspace under an exclusive lock without creating or stealing it.
   * Returns `"busy"` if another tab holds it, or `"missing"` if it does not exist.
   */
  readonly openExisting: (id: string, signal?: AbortSignal) => Promise<WorkspaceWriter | "busy" | "missing">;
  readonly newId?: () => string;
}

export interface CreateOptions {
  readonly signal?: AbortSignal;
  /** Rewrite this incomplete workspace (Retry) instead of creating a new one. */
  readonly into?: string;
}

/** Could not claim an unused workspace id. Nothing was changed. */
export class WorkspaceIdTakenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceIdTakenError";
  }
}

/** Retry was asked for a workspace that is not an unfinished import. Nothing was changed. */
export class NotIncompleteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotIncompleteError";
  }
}

/** Retry was asked for a workspace currently open in another tab. Nothing was changed. */
export class WorkspaceBusyError extends Error {
  constructor(id: string) {
    super(`Workspace ${id} is open in another tab`);
    this.name = "WorkspaceBusyError";
  }
}

/** Retry was asked for a workspace that does not exist. Nothing was changed. */
export class WorkspaceMissingError extends Error {
  constructor(id: string) {
    super(`Workspace ${id} was not found`);
    this.name = "WorkspaceMissingError";
  }
}

/** Retry was asked for a workspace whose recorded source or template does not match. Nothing was changed. */
export class RetrySourceMismatchError extends Error {
  constructor(id: string) {
    super(`Workspace ${id} does not match this retry request`);
    this.name = "RetrySourceMismatchError";
  }
}

/** Ten random characters rarely collide; this many tries makes it practically impossible. */
const ID_ATTEMPTS = 8;

async function claimNewWorkspace(
  deps: NewWorkspaceDeps,
  signal: AbortSignal | undefined,
): Promise<{ readonly id: string; readonly writer: WorkspaceWriter }> {
  const newId = deps.newId ?? newWorkspaceId;
  for (let attempt = 0; attempt < ID_ATTEMPTS; attempt++) {
    signal?.throwIfAborted();
    const id = newId();
    // Each attempt atomically probes and claims a fresh id; candidates cannot be claimed in parallel.
    // oxlint-disable-next-line no-await-in-loop
    const writer = await deps.createNew(id, signal);
    if (writer !== "taken") return { id, writer };
  }
  throw new WorkspaceIdTakenError("Could not find an unused workspace id");
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
  const { id, writer } = await claimNewWorkspace(deps, options.signal);
  return fill(id, writer, files, meta, options.signal);
}

function matchesRetryTarget(current: WorkspaceMeta, requested: WorkspaceMeta): boolean {
  if (current.source || requested.source) {
    if (current.source?.kind !== "github" || requested.source?.kind !== "github") return false;
    return (
      current.source.owner === requested.source.owner &&
      current.source.repo === requested.source.repo &&
      current.source.ref === requested.source.ref &&
      (current.source.subdir ?? "") === (requested.source.subdir ?? "") &&
      (current.template ?? "github") === (requested.template ?? "github")
    );
  }
  return (
    typeof current.template === "string" && current.template !== "" && current.template === requested.template
  );
}

async function clearProjectSubtree(writer: WorkspaceWriter, signal: AbortSignal | undefined): Promise<void> {
  signal?.throwIfAborted();
  await writer.runtime.filesystem.remove(PROJECT_ROOT);
  await writer.runtime.filesystem.mkdirp(PROJECT_ROOT);
  signal?.throwIfAborted();
}

async function rewriteIncomplete(
  id: string,
  files: Readonly<Record<string, string | Uint8Array>>,
  meta: WorkspaceMeta,
  deps: NewWorkspaceDeps,
  signal: AbortSignal | undefined,
): Promise<string> {
  const writer = await deps.openExisting(id, signal);
  if (writer === "busy") throw new WorkspaceBusyError(id);
  if (writer === "missing") throw new WorkspaceMissingError(id);
  try {
    const current = await readMetaFile(writer.runtime.filesystem);
    if (current?.state !== INCOMPLETE) {
      throw new NotIncompleteError(`Workspace ${id} is not an unfinished import`);
    }
    if (!matchesRetryTarget(current, meta)) {
      throw new RetrySourceMismatchError(id);
    }
    await clearProjectSubtree(writer, signal);
  } catch (error) {
    await close(writer);
    throw error;
  }
  return fill(id, writer, files, meta, signal);
}

async function fill(
  id: string,
  writer: WorkspaceWriter,
  files: Readonly<Record<string, string | Uint8Array>>,
  meta: WorkspaceMeta,
  signal: AbortSignal | undefined,
): Promise<string> {
  const { state: _ignored, ...complete } = meta;
  try {
    await writeMeta(writer, { ...complete, state: INCOMPLETE });
    signal?.throwIfAborted();
    await writer.files.writeMany(files);
    await writer.runtime.filesystem.flush();
    signal?.throwIfAborted();
    await writeMeta(writer, complete);
  } catch (error) {
    await close(writer);
    throw error;
  }
  // Every byte is flushed and the marker is cleared: the workspace is complete even if closing fails.
  await close(writer);
  return id;
}

function writeMeta(writer: WorkspaceWriter, meta: WorkspaceMeta): Promise<void> {
  return writeMetaFile(writer.runtime.filesystem, meta);
}

async function close(writer: WorkspaceWriter): Promise<void> {
  await writer.dispose().catch(() => undefined);
}
