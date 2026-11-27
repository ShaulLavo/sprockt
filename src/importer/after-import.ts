// What happens once an imported workspace opens: install dependencies and start the dev server.
// The terminal and task services come from other slices, so this module only holds the hook.
//
// The importer stores the plan in `/.sprockt/workspace.json` (`pendingImport`), on the
// filesystem root outside the project. The workbench
// attaches each live session here; a handler (registered by the terminal or task service, at
// any time) receives the plan once both exist. Under a per-workspace Web Lock the plan is read,
// handed to the handlers, and only then removed from the metadata: a session that detaches
// first, or a removal that fails, leaves the plan for the next attempt. Tabs wait for the lock
// rather than skip it, so a tab whose claim gave up is followed by one that can take over.
import { withWorkspaceMetaLock } from "../workspace/hint";
import type { WorkspaceSession } from "../workspace/session";
import { readMetaFile, writeMetaFile, type ImportPlan } from "./metadata";

export type AfterImportHandler = (session: WorkspaceSession, plan: ImportPlan) => void | Promise<void>;

/** Runs `task` while holding the named lock, waiting for it if another tab holds it. */
export type WithLock = <T>(name: string, task: () => Promise<T>) => Promise<T>;

type AttachedSession = Pick<WorkspaceSession, "id" | "runtime">;

const handlers = new Set<AfterImportHandler>();
const sessions = new Set<AttachedSession>();

let withLock: WithLock = browserLock;
let reportError: (error: unknown) => void = (error) => console.error("An after-import task failed", error);

function browserLock<T>(name: string, task: () => Promise<T>): Promise<T> {
  if (typeof navigator === "undefined" || !navigator.locks) return task();
  return navigator.locks.request(name, task);
}

/** Test seam: replaces the lock and the error reporter. */
export function configureAfterImport(options: {
  readonly withLock?: WithLock;
  readonly reportError?: (error: unknown) => void;
}): void {
  withLock = options.withLock ?? browserLock;
  reportError = options.reportError ?? reportError;
}

/**
 * Under the lock: reads the plan, hands it to the current handlers if the session is still
 * attached, then removes it from the metadata. Returns the handlers' runs to wait on.
 */
async function handOver(session: AttachedSession): Promise<Promise<void>[]> {
  return withWorkspaceMetaLock(session.id, async () => {
    const meta = await readMetaFile(session.runtime.filesystem);
    const plan = meta?.pendingImport;
    // Detached, or no handler yet: the plan stays where it is.
    if (!meta || !plan || !sessions.has(session) || handlers.size === 0) return [];
    // Every handler is called before the removal starts.
    const runs = Array.from(handlers, (handler) => invoke(handler, session as WorkspaceSession, plan));
    const { pendingImport: _taken, ...rest } = meta;
    await writeMetaFile(session.runtime.filesystem, rest);
    return runs;
  });
}

/** Calls the handler now; a synchronous throw becomes a rejected run. */
function invoke(handler: AfterImportHandler, session: WorkspaceSession, plan: ImportPlan): Promise<void> {
  try {
    return Promise.resolve(handler(session, plan));
  } catch (error) {
    return Promise.reject(error);
  }
}

async function dispatch(session: AttachedSession): Promise<void> {
  if (handlers.size === 0 || !sessions.has(session)) return;
  const runs = await withLock(`sprockt:${session.id}:after-import`, () => handOver(session));
  const results = await Promise.allSettled(runs);
  for (const result of results) if (result.status === "rejected") reportError(result.reason);
}

function run(session: AttachedSession): void {
  dispatch(session).catch(reportError);
}

/**
 * The workbench calls this when a session is ready; the returned function detaches it. A plan
 * waiting in the workspace runs as soon as at least one handler is registered.
 */
export function attachAfterImport(session: AttachedSession): () => void {
  sessions.add(session);
  run(session);
  return () => sessions.delete(session);
}

/** Registers what runs after an import. Returns the function that unregisters it. */
export function onAfterImport(handler: AfterImportHandler): () => void {
  handlers.add(handler);
  for (const session of sessions) run(session);
  return () => handlers.delete(handler);
}
