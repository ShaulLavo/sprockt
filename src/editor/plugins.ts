// The mount hook for editor plugins that need the workspace: language servers first of all.
// Document ids are absolute workspace paths, so a language server sees
// `file:///workspace/src/main.ts`.
//
// The editor never waits for a provider. Each one starts on its own; the editor opens at once
// and a provider's plugins are added to the running editor when that provider delivers. One
// that throws or never answers only loses its own plugins.
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

/** One workspace's editor, waiting for plugins. */
interface Mount {
  start(provider: EditorPluginProvider): void;
}

const providers = new Set<EditorPluginProvider>();
const mounts = new Set<Mount>();

/**
 * Adds a provider for every workspace: the ones opened from now on, and the one that is open.
 * Returns the function that removes it for workspaces opened later.
 */
export function registerEditorPlugins(provider: EditorPluginProvider): () => void {
  providers.add(provider);
  for (const mount of mounts) mount.start(provider);
  return () => providers.delete(provider);
}

const asSet = (provided: Provided): EditorPluginSet =>
  "plugins" in provided ? provided : { plugins: provided };

const failed = (what: string) => (error: unknown) => console.error(what, error);

/** A set that fails to shut down must not keep the others from shutting down. */
function disposeQuietly(set: EditorPluginSet): void {
  try {
    set.dispose?.();
  } catch (error) {
    failed("Disposing editor plugins failed")(error);
  }
}

/**
 * Starts every registered provider for one workspace. `onPlugins` is called with the plugins
 * of each provider when it delivers; they are meant to be added to the editor that is already
 * running. The returned function ends the workspace's plugins: it aborts `signal` and disposes
 * every set, including one that arrives afterwards.
 */
export function mountEditorPlugins(
  host: Omit<EditorHostContext, "signal">,
  onPlugins: (plugins: readonly EditorPlugin[]) => void,
): () => void {
  const lifetime = new AbortController();
  const context: EditorHostContext = { ...host, signal: lifetime.signal };
  const delivered: EditorPluginSet[] = [];

  function accept(provided: Provided): void {
    const set = asSet(provided);
    if (lifetime.signal.aborted) return disposeQuietly(set);
    delivered.push(set);
    onPlugins(set.plugins);
  }

  const mount: Mount = {
    start(provider) {
      // The async wrapper turns a synchronous throw into this provider's own rejection.
      const started = (async () => provider(context))();
      started.then(accept).catch(failed("Editor plugin provider failed"));
    },
  };
  mounts.add(mount);
  for (const provider of providers) mount.start(provider);

  return () => {
    mounts.delete(mount);
    lifetime.abort();
    for (const set of delivered.splice(0)) disposeQuietly(set);
  };
}
