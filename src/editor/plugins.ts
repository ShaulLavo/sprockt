// The mount hook for editor plugins that need the workspace, language servers first of all.
//
// A language-server lane plugs in with one file and one call:
//
//   // src/lsp/typescript.ts
//   registerEditorPlugins(async ({ runtime, rootUri, signal }) => {
//     const server = await startTypeScriptServer(runtime, { signal });
//     return { plugins: [createLanguageServerPlugin({ transport: server.transport, rootUri })], dispose: server.stop };
//   });
//
// Rules a provider can rely on:
// - It is called once per editor with the workspace runtime and project root. Document ids are
//   absolute workspace paths, so a language server sees `file:///workspace/src/main.ts`.
// - The editor never waits for it. The editor opens with its built-in plugins (syntax, find) and
//   each provider's plugins are added to the live editor when that provider delivers, so a slow,
//   stalled or failing provider only delays or loses its own plugins.
// - `signal` aborts when the editor closes, or when another tab takes the workspace over.
//   `dispose` (when returned) runs then too, and also for a set that arrives after that; such a
//   set is never mounted.
// - Registering after an editor exists mounts the plugins on it; calling the returned function
//   removes them from every editor again.
import type { EditorDisposable, EditorPlugin } from "@singapore-editor/core/extensions";
import type { Runtime } from "waffle";
import type { StatusItems } from "../workbench/slots";

export interface EditorHostContext {
  readonly runtime: Runtime;
  /** Absolute path of the project inside the workspace filesystem. */
  readonly projectRoot: string;
  /** `file://` URI of the project root, for a language server's `rootUri`. */
  readonly rootUri: string;
  /** Optional workbench status bar, so providers can report readiness quietly. */
  readonly status?: StatusItems;
  /**
   * Aborted when the editor closes, or when another tab takes the workspace over and this tab's
   * files stop being live: stop starting things, and stop what was started.
   */
  readonly signal: AbortSignal;
  /**
   * Opens a project file in the editor, as go-to-definition does: `path` is absolute, `line` and
   * `column` are 1-based. False when the path is outside the project.
   */
  openFile(path: string, position?: { readonly line: number; readonly column: number }): boolean;
}

/** Plugins together with what has to be shut down when the editor closes. */
export interface EditorPluginSet {
  readonly plugins: readonly EditorPlugin[];
  dispose?(): void;
}

type Provided = readonly EditorPlugin[] | EditorPluginSet;
export type EditorPluginProvider = (context: EditorHostContext) => Provided | Promise<Provided>;

/** What a provider's plugins are mounted on: Singapore's `Editor` has this shape. */
export interface EditorPluginHost {
  addPlugin(plugin: EditorPlugin): EditorDisposable;
}

type RegistryListener = (provider: EditorPluginProvider, registered: boolean) => void;

const providers = new Set<EditorPluginProvider>();
const listeners = new Set<RegistryListener>();

/** Adds a provider for every editor, open now or later. Returns the function that removes it. */
export function registerEditorPlugins(provider: EditorPluginProvider): () => void {
  if (!providers.has(provider)) {
    providers.add(provider);
    for (const listener of listeners) listener(provider, true);
  }
  return () => unregister(provider);
}

function unregister(provider: EditorPluginProvider): void {
  if (!providers.delete(provider)) return;
  for (const listener of listeners) listener(provider, false);
}

const asSet = (provided: Provided): EditorPluginSet =>
  "plugins" in provided ? provided : { plugins: provided };

/** One provider's run on one editor: its own abort signal and, once delivered, its plugins. */
interface Mounted {
  readonly lifetime: AbortController;
  disposables: EditorDisposable[];
  set?: EditorPluginSet;
}

/**
 * Mounts every registered provider's plugins on `host`, follows later registrations, and returns
 * the function that removes them all. Each provider is isolated: a throw, a rejection or a promise
 * that never settles affects nothing but that provider.
 */
export function mountEditorPlugins(
  host: Omit<EditorHostContext, "signal">,
  editor: EditorPluginHost,
): () => void {
  const mounted = new Map<EditorPluginProvider, Mounted>();

  async function start(provider: EditorPluginProvider): Promise<void> {
    const entry: Mounted = { lifetime: new AbortController(), disposables: [] };
    mounted.set(provider, entry);
    try {
      // Awaiting first turns a provider that throws synchronously into this provider's rejection.
      await Promise.resolve();
      const set = asSet(await provider({ ...host, signal: entry.lifetime.signal }));
      // The provider may have been removed, or the editor closed, while it was starting.
      if (entry.lifetime.signal.aborted) return set.dispose?.();
      entry.set = set;
      entry.disposables = set.plugins.map((plugin) => editor.addPlugin(plugin));
    } catch (error) {
      if (!entry.lifetime.signal.aborted) console.error("An editor plugin provider failed", error);
    }
  }

  function stop(provider: EditorPluginProvider): void {
    const entry = mounted.get(provider);
    if (!entry) return;
    mounted.delete(provider);
    entry.lifetime.abort();
    for (const disposable of entry.disposables) disposable.dispose();
    entry.set?.dispose?.();
  }

  const listener: RegistryListener = (provider, registered) => {
    if (registered) void start(provider);
    else stop(provider);
  };
  listeners.add(listener);
  for (const provider of providers) void start(provider);
  return () => {
    listeners.delete(listener);
    for (const provider of Array.from(mounted.keys())) stop(provider);
  };
}
