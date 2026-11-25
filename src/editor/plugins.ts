// The mount hook for editor plugins that need the workspace: language servers first of all.
// A provider is asked once per editor and returns Singapore plugins. Document ids are absolute
// workspace paths, so a language server sees `file:///workspace/src/main.ts`.
import type { EditorPlugin } from "@singapore-editor/core/extensions";
import type { Runtime } from "waffle";

export interface EditorHostContext {
  readonly runtime: Runtime;
  /** Absolute path of the project inside the workspace filesystem. */
  readonly projectRoot: string;
  /** `file://` URI of the project root, for a language server's `rootUri`. */
  readonly rootUri: string;
}

export type EditorPluginProvider = (
  context: EditorHostContext,
) => readonly EditorPlugin[] | Promise<readonly EditorPlugin[]>;

const providers = new Set<EditorPluginProvider>();

/** Adds a provider for every editor opened from now on. Returns the function that removes it. */
export function registerEditorPlugins(provider: EditorPluginProvider): () => void {
  providers.add(provider);
  return () => providers.delete(provider);
}

/** A provider that fails only loses its own plugins; the editor still opens. */
export async function resolveEditorPlugins(context: EditorHostContext): Promise<EditorPlugin[]> {
  const results = await Promise.allSettled(Array.from(providers, (provider) => provider(context)));
  return results.flatMap((result) => {
    if (result.status === "fulfilled") return result.value;
    console.error("Editor plugin provider failed", result.reason);
    return [];
  });
}
