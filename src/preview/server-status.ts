import type { DevServerStatus } from "../tasks/dev-server";
import { fill } from "../ui/format";
import type { StatusItem } from "../workbench/slots";
import { ui } from "./copy";

/** A port as every place prints it: `:5173`. */
export const portLabel = (port: number): string => fill(ui.port, { port });

/**
 * The ports a pane lists: this tab's own servers, and those of the tab that runs the workspace's
 * dev server. The preview address is the same for both.
 */
export function listedPorts(local: readonly number[], remote: readonly number[]): number[] {
  return Array.from(new Set(local.concat(remote))).sort((a, b) => a - b);
}

export const samePorts = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((port, index) => port === b[index]);

export interface ServerState {
  /** The port the preview shows, whoever opened it. */
  readonly port: number | undefined;
  /** The workspace's dev server task, in whichever tab it runs. */
  readonly task: DevServerStatus;
  /** Whether this tab runs the task. */
  readonly owned: boolean;
  stop(): void;
}

function described(port: number, state: ServerState): StatusItem {
  const elsewhere = state.task !== "stopped" && !state.owned;
  const title = fill(elsewhere ? ui.serverElsewhere : ui.serverRunning, { port });
  return { text: portLabel(port), title, tone: "ok" };
}

/**
 * What the title bar's dev server pill shows: the port while a server listens, a word while the
 * task starts, and nothing otherwise. The stop button is there only in the tab that runs the
 * task: a server started in a terminal is stopped there, and another tab's task in that tab.
 */
export function serverStatus(state: ServerState): StatusItem | undefined {
  const { port, task } = state;
  if (port === undefined && task === "stopped") return undefined;
  const shown: StatusItem = port === undefined ? { text: ui.serverStarting } : described(port, state);
  if (!state.owned) return shown;
  return { ...shown, action: { label: ui.stopAction, icon: "stop", run: state.stop } };
}
