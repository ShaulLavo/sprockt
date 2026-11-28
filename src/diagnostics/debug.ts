// `globalThis.sprockt`: a small window into the running workbench for the browser console and
// the end-to-end tests. The terminal draws on a canvas and the editor only mounts the rows on
// screen, so their full text is only reachable from here.
import { registerEditorPlugins } from "../editor/plugins";
import type { TerminalHandle } from "../terminal/session";
import type { WorkspaceSession } from "../workspace/session";

export interface SprocktDebug {
  workspace?: WorkspaceSession;
  /** Rows of the active terminal, top to bottom. Empty until a terminal is open. */
  terminalLines: () => string[];
  /** The active terminal's screen size and the size its shell was told. Undefined with none open. */
  terminalSize?: () => ReturnType<TerminalHandle["size"]> | undefined;
  /** The whole text of the document in the editor. Empty until a file is open. */
  editorText: () => string;
  /** Adds an editor plugin provider, as a lazily loaded language server would. */
  registerEditorPlugins: typeof registerEditorPlugins;
}

declare global {
  var sprockt: SprocktDebug | undefined;
}

export function debugHandle(): SprocktDebug {
  globalThis.sprockt ??= { terminalLines: () => [], editorText: () => "", registerEditorPlugins };
  return globalThis.sprockt;
}
