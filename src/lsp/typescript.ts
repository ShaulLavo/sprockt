// TypeScript IntelliSense in the editor: diagnostics, hover, completion and go-to-definition,
// into other files and into `node_modules`. The server runs on the workspace's own Waffle
// runtime (tsrs today, see ./servers.ts for the seam), the Singapore LSP plugin is its client,
// and ./glue.ts connects the two over the process's stdin and stdout.
//
// Order matters: the plugin starts the server as soon as it is mounted, so the program is
// installed first. Otherwise the first start fails with ExecutableNotFound and uses up the
// first restart delay.
import type { Runtime } from "waffle";
import type { EditorHostContext, EditorPluginSet } from "../editor/plugins";
import { watchFilesystemEvents } from "../files/watch";
import { createGuestLanguageServerPlugin, disposeLanguageServers } from "./glue";
import { checkForScripts, hasOwnScriptFile, projectRelativeName } from "./project";
import type { TypeScriptServer } from "./servers";
import { tsrs } from "./tsrs";
import { watchProjectFiles } from "./watch";

const SERVER: TypeScriptServer = tsrs;

/** Whether the tree at `absolute` holds a script file of the project's own. */
async function subtreeHasScript(runtime: Runtime, projectRoot: string, absolute: string): Promise<boolean> {
  // A path that is gone, or is a file, lists nothing.
  const files = await runtime.filesystem.listFiles(absolute).catch((): string[] => []);
  return hasOwnScriptFile(
    files.flatMap((path) => {
      const name = projectRelativeName(projectRoot, path.slice(1));
      return name === undefined ? [] : [name];
    }),
  );
}

/**
 * Resolves once the project has a TypeScript or JavaScript file of its own, at once when it
 * already has one. A project without any never pays for the server's download or memory.
 *
 * The watch is registered before the project is listed (its first update is a resync), so a
 * file that arrives in between is seen by one or the other. A directory moved or created in the
 * project announces only itself, so its tree is listed too.
 */
function untilScriptFiles(context: EditorHostContext): Promise<void> {
  const { runtime, projectRoot, signal } = context;
  return new Promise<void>((resolve, reject) => {
    let found = false;
    const finish = (hasScript: boolean): void => {
      if (!hasScript || found) return;
      found = true;
      stop();
      resolve();
    };
    const recheck = (absolute: string): void =>
      void subtreeHasScript(runtime, projectRoot, absolute).then(finish, (error: unknown) =>
        console.warn("Could not list the project for TypeScript files", error),
      );
    const stop = watchFilesystemEvents(
      runtime,
      (update) => {
        if (update === "resync") return recheck(projectRoot);
        const check = checkForScripts(projectRoot, update);
        if (check.found) return finish(true);
        for (const path of check.recheck) recheck(path);
      },
      { resyncOnFirstOpen: true },
    );
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
    onStart: watched.started,
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
