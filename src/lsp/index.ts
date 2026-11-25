// Registers the language servers with the editor. The provider is loaded on first use, so the
// landing page and a workbench without an editor carry none of the LSP code.
import { registerEditorPlugins } from "../editor/plugins";

export function registerLanguageServers(): () => void {
  return registerEditorPlugins(async (context) => (await import("./typescript")).typescriptPlugins(context));
}
