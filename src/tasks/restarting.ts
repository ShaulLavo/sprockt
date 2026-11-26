// A server command that does not reload itself (plain `bun server.ts`), kept current by running
// it again when the project's source changes. bun-wasm has no `--watch`, and its `--hot` refuses
// ordinary servers, so for a bare entry file this is what makes an edit show.
import type { FileChange } from "../files/service";
import type { ServerProcess } from "./dev-server-line";

/** One run of the command. */
export interface Run {
  /** Resolves when the run has ended and its output was read. Never rejects. */
  readonly done: Promise<void>;
  /** Asks the run to end. Harmless once it has. */
  interrupt(): void;
}

export interface RestartingOptions {
  /** The command for the first run, which may install first. */
  readonly script: string;
  /** The command for every run after a change, or undefined for a command that reloads itself. */
  readonly rerun: string | undefined;
  open(script: string): Promise<Run>;
  /** Calls back when the project's source changed. Returns the unsubscribe. */
  onSourceChange(listener: () => void): () => void;
  /** Called before each run after the first. */
  onRestart?(): void;
}

/** Code, and the pages and styles a server reads when it starts. */
const SOURCE = /\.(?:[cm]?[jt]sx?|html?|css)$/i;

const installed = (path: string) =>
  path.split("/").some((part) => part === "node_modules" || part === ".git");

/**
 * Whether a change is one the server has to be run again for. Data the server writes itself (a
 * database, a JSON file, a log) is not: restarting for it would never end.
 */
export function isSourceChange(change: Pick<FileChange, "paths" | "reset">): boolean {
  return change.reset || change.paths.some((path) => SOURCE.test(path) && !installed(path));
}

/**
 * Runs the command, and runs it again after each source change. As a process it has ended when
 * a run ended by itself or `stop` was called; a restart in between is not an end.
 */
export async function restartingProcess(options: RestartingOptions): Promise<ServerProcess> {
  let run = await options.open(options.script);
  let stopped = false;
  let changed = false;

  const unsubscribe =
    options.rerun === undefined
      ? () => {}
      : options.onSourceChange(() => {
          changed = true;
          run.interrupt();
        });

  async function runs(rerun: string | undefined): Promise<void> {
    for (;;) {
      // One run after the other: each wait is for the run that is current.
      // oxlint-disable-next-line no-await-in-loop
      await run.done;
      if (stopped || !changed || rerun === undefined) return;
      changed = false;
      options.onRestart?.();
      // oxlint-disable-next-line no-await-in-loop
      run = await options.open(rerun);
      // A stop or another change may have come while this run was being created.
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
