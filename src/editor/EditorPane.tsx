import type { EditorPlugin } from "@singapore-editor/core/extensions";
import "@singapore-editor/core/style.css";
import { createEditor, type SolidEditorDocument } from "@singapore-editor/solid";
import { createEffect, createResource, createSignal, on, Show } from "solid-js";
import { debugHandle } from "../app/debug";
import { PROJECT_ROOT } from "../workspace/paths";
import { useWorkspace } from "../workspace/session";
import { languageOf } from "./languages";
import { resolveEditorPlugins } from "./plugins";
import type { EditorStore } from "./store";

function EditorView(props: { store: EditorStore; plugins: readonly EditorPlugin[] }) {
  const workspace = useWorkspace();
  const [document, setDocument] = createSignal<SolidEditorDocument | null>(null);

  async function load(path: string): Promise<void> {
    const text = await workspace.files.read(path);
    // The user may have opened another file while this one was being read.
    if (props.store.active() !== path) return;
    setDocument({
      documentId: `${PROJECT_ROOT}/${path}`,
      defaultText: text ?? "",
      languageId: languageOf(path),
    });
    props.store.setDirty(false);
  }

  createEffect(
    on(props.store.active, (path) => {
      if (path) void load(path);
      else setDocument(null);
    }),
  );

  const controller = createEditor({
    document,
    plugins: props.plugins,
    onChange: (_state, change) => {
      if (change) props.store.setDirty(true);
    },
  });

  debugHandle().editorText = () => (document() ? controller.materializeFullText() : "");

  async function save(): Promise<void> {
    const path = props.store.active();
    if (!path) return;
    await workspace.files.write(path, controller.materializeFullText());
    props.store.setDirty(false);
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== "s" || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    void save();
  }

  return <div class="editor-host" data-testid="editor" ref={controller.ref} onKeyDown={onKeyDown} />;
}

export function EditorPane(props: { store: EditorStore }) {
  const workspace = useWorkspace();
  const [plugins] = createResource(() =>
    resolveEditorPlugins({
      runtime: workspace.runtime,
      projectRoot: PROJECT_ROOT,
      rootUri: `file://${PROJECT_ROOT}`,
    }),
  );

  return (
    <section class="pane editor-pane" aria-label="Editor">
      <header class="pane-header">
        <span data-testid="editor-file">{props.store.active() ?? "No file open"}</span>
        <Show when={props.store.dirty()}>
          <span class="pane-status" title="Unsaved changes">
            ●
          </span>
        </Show>
      </header>
      <Show when={plugins()}>{(resolved) => <EditorView store={props.store} plugins={resolved()} />}</Show>
    </section>
  );
}
