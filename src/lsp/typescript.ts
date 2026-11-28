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
import { watchFilesystemEvents, type WatchUpdate } from "../files/watch";
import { STATUS_SLOT, type StatusItem } from "../workspace/session/slots";
import { createGuestLanguageServerPlugin, disposeLanguageServers } from "./glue";
import {
  checkForScripts,
  declaredPackages,
  hasOwnScriptFile,
  projectRelativeName,
  touchesDependencyState,
} from "./project";
import type { TypeScriptServer } from "./servers";
import { tsrs } from "./tsrs";
import { watchProjectFiles } from "./watch";

const SERVER: TypeScriptServer = tsrs;

function waitingForDepsStatus(missingCount: number): StatusItem {
  const noun = missingCount === 1 ? "package" : "packages";
  return {
    text: "Install deps for TS",
    title: `TypeScript checks wait for ${missingCount} uninstalled ${noun} (run bun install or start the dev server).`,
    side: "end",
    order: 9,
    tone: "neutral",
  };
}

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

/** Number of direct packages declared in `package.json` not yet present under `node_modules`. */
async function missingDependencyCount(runtime: Runtime, projectRoot: string): Promise<number> {
  const bytes = await runtime.filesystem.readFile(`${projectRoot}/package.json`).catch(() => undefined);
  const text = bytes ? new TextDecoder().decode(bytes) : undefined;
  const packages = declaredPackages(text);
  if (packages.length === 0) return 0;
  const resolved = await Promise.all(
    packages.map((name) =>
      runtime.filesystem
        .resolvePath(`${projectRoot}/node_modules/${name}/package.json`)
        .catch(() => undefined),
    ),
  );
  return resolved.filter((entry) => entry === undefined).length;
}

/** Tracks whether the workspace has TypeScript/JavaScript sources and installed dependencies. */
class ProjectReadyWaiter {
  private hasScript = false;
  private missingDeps: number | undefined;
  private depCheckSeq = 0;
  private finished = false;
  private readonly stopWatch: () => void;

  constructor(
    private readonly context: EditorHostContext,
    private readonly onReady: () => void,
    private readonly onAbort: (reason: unknown) => void,
  ) {
    this.stopWatch = watchFilesystemEvents(context.runtime, (update) => this.handleUpdate(update), {
      resyncOnFirstOpen: true,
    });
    context.signal.addEventListener("abort", () => this.abort(), { once: true });
  }

  private clearStatus(): void {
    this.context.status?.set(STATUS_SLOT.typescript, undefined);
  }

  private evaluate(): void {
    if (this.finished) return;
    if (this.hasScript && this.missingDeps === 0) {
      this.finished = true;
      this.clearStatus();
      this.stopWatch();
      this.onReady();
      return;
    }
    const statusItem =
      this.hasScript && this.missingDeps !== undefined && this.missingDeps > 0
        ? waitingForDepsStatus(this.missingDeps)
        : undefined;
    this.context.status?.set(STATUS_SLOT.typescript, statusItem);
  }

  private markScriptFound(found: boolean): void {
    if (!found || this.hasScript || this.finished) return;
    this.hasScript = true;
    this.evaluate();
  }

  private recheckScripts(absolute: string): void {
    if (this.hasScript || this.finished) return;
    const { runtime, projectRoot } = this.context;
    void subtreeHasScript(runtime, projectRoot, absolute).then(
      (found) => this.markScriptFound(found),
      (error: unknown) => console.warn("Could not list the project for TypeScript files", error),
    );
  }

  private recheckDependencies(): void {
    if (this.finished) return;
    const seq = ++this.depCheckSeq;
    this.missingDeps = undefined;
    const { runtime, projectRoot } = this.context;
    void missingDependencyCount(runtime, projectRoot).then(
      (missing) => this.applyDependencyCheck(seq, missing),
      (error: unknown) => console.warn("Could not check project dependencies for TypeScript", error),
    );
  }

  private applyDependencyCheck(seq: number, missing: number): void {
    if (this.finished || seq !== this.depCheckSeq) return;
    this.missingDeps = missing;
    this.evaluate();
  }

  private handleUpdate(update: WatchUpdate): void {
    const { projectRoot } = this.context;
    if (update === "resync") {
      this.recheckScripts(projectRoot);
      this.recheckDependencies();
      return;
    }
    if (touchesDependencyState(projectRoot, update)) this.recheckDependencies();
    if (this.hasScript) return;
    const check = checkForScripts(projectRoot, update);
    if (check.found) return this.markScriptFound(true);
    for (const path of check.recheck) this.recheckScripts(path);
  }

  private abort(): void {
    if (this.finished) return;
    this.finished = true;
    this.clearStatus();
    this.stopWatch();
    this.onAbort(this.context.signal.reason);
  }
}

/**
 * Resolves once the project has a TypeScript or JavaScript file of its own and its declared
 * dependencies (if any) are installed in `node_modules`.
 */
function untilTypeScriptReady(context: EditorHostContext): Promise<void> {
  if (context.signal.aborted) return Promise.reject(context.signal.reason);
  return new Promise<void>((resolve, reject) => {
    void new ProjectReadyWaiter(context, resolve, reject);
  });
}

/** The editor plugin provider: registered once, run for every editor that opens. */
export async function typescriptPlugins(context: EditorHostContext): Promise<EditorPluginSet> {
  const { runtime, projectRoot, signal } = context;
  await untilTypeScriptReady(context);
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
