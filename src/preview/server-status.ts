import type { DevServerStatus } from "../tasks/dev-server";
import { fill } from "../ui/format";
import type { StatusItem } from "../workbench/slots";
import { ui } from "./copy";

/** A port as every place prints it: `:5173`. */
export const portLabel = (port: number): string => fill(ui.port, { port });

export interface ServerState {
  /** The port the preview shows, whoever opened it. */
  readonly port: number | undefined;
  /** The dev server the pane started, if any. */
  readonly task: DevServerStatus;
  stop(): void;
}

/**
 * What the title bar's dev server pill shows: the port while a server listens, a word while the
 * pane's own server starts, and nothing otherwise. Only a server the pane started has a stop
 * button; one started in the terminal is stopped there.
 */
export function serverStatus(state: ServerState): StatusItem | undefined {
  const { port, task } = state;
  if (port === undefined && task === "stopped") return undefined;
  const shown: StatusItem =
    port === undefined
      ? { text: ui.serverStarting }
      : { text: portLabel(port), title: fill(ui.serverRunning, { port }), tone: "ok" };
  if (task === "stopped") return shown;
  return { ...shown, action: { label: ui.stopAction, icon: "stop", run: state.stop } };
}
