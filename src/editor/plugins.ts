// The mount hook for editor plugins that need the workspace: language servers first of all.
// Document ids are absolute workspace paths, so a language server sees
// `file:///workspace/src/main.ts`.
//
// The editor never waits for a provider. Each one starts on its own; the editor opens at once
// and gains a provider's plugins when that provider delivers. One that throws or never answers
// only loses its own plugins.
import type { EditorPlugin } from "@singapore-editor/core/extensions";
import type { Runtime } from "waffle";

export interface EditorHostContext {
  readonly runtime: Runtime;
  /** Absolute path of the project inside the workspace filesystem. */
  readonly projectRoot: string;
  /** `file://` URI of the project root, for a language server's `rootUri`. */
  readonly rootUri: string;
  /** Aborted when the workspace closes: stop starting things, and stop what was started. */
  readonly signal: AbortSignal;
}

/** Plugins together with what has to be shut down when the workspace closes. */
export interface EditorPluginSet {
  readonly plugins: readonly EditorPlugin[];
  dispose?(): void;
}

type Provided = readonly EditorPlugin[] | EditorPluginSet;
export type EditorPluginProvider = (context: EditorHostContext) => Provided | Promise<Provided>;

const providers = new Set<EditorPluginProvider>();

/** Adds a provider for every workspace opened from now on. Returns the function that removes it. */
export function registerEditorPlugins(provider: EditorPluginProvider): () => void {
  providers.add(provider);
  return () => providers.delete(provider);
}

const asSet = (provided: Provided): EditorPluginSet =>
  "plugins" in provided ? provided : { plugins: provided };

/**
 * Starts every registered provider for one workspace. `onPlugins` is called with all plugins
 * delivered so far each time a provider answers. The returned function ends the workspace's
 * plugins: it aborts `signal` and disposes every set, including one that arrives afterwards.
 */
export function mountEditorPlugins(
  host: Omit<EditorHostContext, "signal">,
  onPlugins: (plugins: EditorPlugin[]) => void,
): () => void {
  const lifetime = new AbortController();
  const context: EditorHostContext = { ...host, signal: lifetime.signal };
  const delivered: EditorPluginSet[] = [];

  function accept(provided: Provided): void {
    const set = asSet(provided);
    if (lifetime.signal.aborted) return set.dispose?.();
    delivered.push(set);
    onPlugins(delivered.flatMap((each) => each.plugins));
  }

  for (const provider of providers) {
    // The async wrapper turns a synchronous throw into this provider's own rejection.
    const started = (async () => provider(context))();
    started.then(accept).catch((error: unknown) => console.error("Editor plugin provider failed", error));
  }

  return () => {
    lifetime.abort();
    for (const set of delivered.splice(0)) set.dispose?.();
  };
}
