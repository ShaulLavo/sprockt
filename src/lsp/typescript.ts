// TypeScript IntelliSense in the editor: diagnostics, hover, completion and go-to-definition,
// into other files and into `node_modules`. The server runs on the workspace's own Waffle
// runtime (tsrs today, see ./servers.ts for the seam), the Singapore LSP plugin is its client,
// and ./glue.ts connects the two over the process's stdin and stdout.
//
// Order matters: the plugin starts the server as soon as it is mounted, so the program is
// installed first. Otherwise the first start fails with ExecutableNotFound and uses up the
// first restart delay.
import type { EditorHostContext, EditorPluginSet } from "../editor/plugins";
import { watchFilesystem } from "../files/watch";
import { createGuestLanguageServerPlugin, disposeLanguageServers } from "./glue";
import { hasOwnScriptFile, projectRelativeName } from "./project";
import type { TypeScriptServer } from "./servers";
import { tsrs } from "./tsrs";
import { watchProjectFiles } from "./watch";

const SERVER: TypeScriptServer = tsrs;

/**
 * Resolves once the project has a TypeScript or JavaScript file of its own, at once when it
 * already has one. A project without any never pays for the server's download or memory.
 */
async function untilScriptFiles(context: EditorHostContext): Promise<void> {
  const { runtime, projectRoot, signal } = context;
  const relative = (await runtime.filesystem.listFiles(projectRoot)).flatMap((path) => {
    const name = projectRelativeName(projectRoot, path.slice(1));
    return name === undefined ? [] : [name];
  });
  if (hasOwnScriptFile(relative)) return;
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const stop = watchFilesystem(runtime, (names) => {
      const created = names.some((name) => {
        const path = name === null ? undefined : projectRelativeName(projectRoot, name);
        return path !== undefined && hasOwnScriptFile([path]);
      });
      if (!created) return;
      stop();
      resolve();
    });
    signal.addEventListener("abort", () => (stop(), reject(signal.reason)), { once: true });
  });
}

/** The editor plugin provider: registered once, run for every editor that opens. */
export async function typescriptPlugins(context: EditorHostContext): Promise<EditorPluginSet> {
  const { runtime, projectRoot, signal } = context;
  await untilScriptFiles(context);
  const server = await SERVER.install(runtime, projectRoot);
  // The editor closed meanwhile: mount nothing, start nothing.
  if (signal.aborted) return { plugins: [] };
  const watched = watchProjectFiles(runtime, projectRoot);
  const plugin = createGuestLanguageServerPlugin(runtime, "typescript", server, {
    // LSP positions are 0-based; the editor's are 1-based.
    openFile: (path, range) =>
      context.openFile(path, { line: range.start.line + 1, column: range.start.character + 1 }),
    onConnected: watched.connected,
  });
  return {
    plugins: [plugin],
    dispose() {
      watched.stop();
      // Stop the server now, not after the pool's idle grace: its runtime is going away.
      disposeLanguageServers();
    },
  };
}
