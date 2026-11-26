// A server command that does not reload itself (plain `bun server.ts`), kept current by running
// it again when a person edits the project's source. bun-wasm has no `--watch`, and its `--hot`
// refuses ordinary servers, so for a bare entry file this is what makes an edit show.
//
// Only edits made through the file service count (the editor, the explorer, an upload). What
// a program writes does not, whatever the file is called: a server that generates a page when it
// starts would otherwise restart itself for ever. The restarts are also capped, so that nothing
// else can make a loop of them either.
import type { FileChange } from "../files/service";
import type { ServerProcess } from "./dev-server-line";

/** One run of the command. */
export interface Run {
  /** Resolves when the run has ended and its output was read. Never rejects. */
  readonly done: Promise<void>;
  /** Asks the run to end. Harmless once it has. */
  interrupt(): void;
}

/** How many restarts are allowed within how long. */
export interface RestartLimit {
  readonly restarts: number;
  readonly windowMs: number;
}

export const RESTART_LIMIT: RestartLimit = { restarts: 3, windowMs: 30_000 };

export interface RestartingOptions {
  /** The command for the first run, which may install first. */
  readonly script: string;
  /** The command for every run after an edit, or undefined for a command that reloads itself. */
  readonly rerun: string | undefined;
  /** Aborted when the server is no longer wanted: a run created after that is ended at once. */
  readonly signal?: AbortSignal;
  open(script: string): Promise<Run>;
  /** Calls back when a person edited the project's source. Returns the unsubscribe. */
  onSourceEdit(listener: () => void): () => void;
  /** Called before each run after the first. */
  onRestart?(): void;
  /**
   * Called with true when an edit was not picked up because the restarts of the window were
   * used up, and with false when a later restart went through.
   */
  onHeld?(held: boolean): void;
  readonly limit?: RestartLimit;
  /** The clock the limit is counted on, in milliseconds. */
  now?(): number;
}

/** Code, and the pages and styles a server reads when it starts. */
const SOURCE = /\.(?:[cm]?[jt]sx?|html?|css)$/i;

const installed = (path: string) =>
  path.split("/").some((part) => part === "node_modules" || part === ".git");

/** Whether a change touched the project itself, not only what is installed into it. */
export function affectsProject(change: Pick<FileChange, "paths" | "reset">): boolean {
  return change.reset || change.paths.some((path) => !installed(path));
}

/** Whether an edit is one the server has to be run again for: source, and not installed code. */
export function isSourceEdit(paths: readonly string[]): boolean {
  return paths.some((path) => SOURCE.test(path) && !installed(path));
}

/**
 * Runs the command, and runs it again after an edit to the source. As a process it has ended
 * when a run ended by itself or `stop` was called; a restart in between is not an end.
 */
export async function restartingProcess(options: RestartingOptions): Promise<ServerProcess> {
  const limit = options.limit ?? RESTART_LIMIT;
  const now = options.now ?? Date.now;
  /** When the restarts of the current window happened. */
  const recent: number[] = [];
  let run = await options.open(options.script);
  let stopped = options.signal?.aborted ?? false;
  let changed = false;
  if (stopped) run.interrupt();

  function mayRestart(): boolean {
    const time = now();
    while (recent.length > 0 && time - (recent[0] ?? time) >= limit.windowMs) recent.shift();
    return recent.length < limit.restarts;
  }

  function onEdit(): void {
    if (stopped) return;
    // Used up: the server keeps running what it has, and the pane says the edit is not in it.
    if (!changed && !mayRestart()) return void options.onHeld?.(true);
    changed = true;
    run.interrupt();
  }

  const unsubscribe = options.rerun === undefined ? () => {} : options.onSourceEdit(onEdit);

  async function runs(rerun: string | undefined): Promise<void> {
    for (;;) {
      // One run after the other: each wait is for the run that is current.
      // oxlint-disable-next-line no-await-in-loop
      await run.done;
      if (stopped || !changed || rerun === undefined) return;
      changed = false;
      recent.push(now());
      options.onHeld?.(false);
      options.onRestart?.();
      // oxlint-disable-next-line no-await-in-loop
      run = await options.open(rerun);
      // A stop or another edit may have come while this run was being created.
      if (stopped || changed) run.interrupt();
    }
  }

  return {
    command: options.script,
    exited: runs(options.rerun).finally(unsubscribe),
    stop() {
      stopped = true;
      run.interrupt();
    },
  };
}
