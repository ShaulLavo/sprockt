import type { EditorPlugin } from "@singapore-editor/core/extensions";
import "@singapore-editor/core/style.css";
import { createEditor, type SolidEditorDocument } from "@singapore-editor/solid";
import { createEffect, createSignal, on, onCleanup, Show } from "solid-js";
import { debugHandle } from "../app/debug";
import { PROJECT_ROOT } from "../workspace/paths";
import { useWorkspace } from "../workspace/session";
import "./editor.css";
import { languageOf } from "./languages";
import { mountEditorPlugins } from "./plugins";
import { discardRecovered, leaveForRecovery } from "./recovery";
import type { EditorStore } from "./store";

const TEXT_CHANGES: ReadonlySet<string> = new Set(["edit", "undo", "redo", "checkout"]);

const idOf = (path: string) => `${PROJECT_ROOT}/${path}`;
const pathOf = (documentId: string | null) => documentId?.slice(PROJECT_ROOT.length + 1);

const documentFor = (path: string, text: string): SolidEditorDocument => ({
  documentId: idOf(path),
  defaultText: text,
  languageId: languageOf(path),
});

export function EditorPane(props: { store: EditorStore }) {
  const workspace = useWorkspace();
  const { store } = props;
  const { documents } = store;
  const [document, setDocument] = createSignal<SolidEditorDocument | null>(null);
  /** True while we put text on screen ourselves: that is not the person editing. */
  let placing = false;
  let closed = false;

  const controller = createEditor({
    document,
    editability: () => (workspace.files.writable() ? "editable" : "readonly"),
    onChange: (state, change) => {
      // The editor also reports selection moves here; only a change of the text is an edit.
      if (!change || placing || !TEXT_CHANGES.has(change.kind)) return;
      // An edit is reported a moment after it happened, by which time another file may be on
      // screen: it counts for the document it was made in.
      documents.edited(pathOf(state.documentId));
      store.changed();
    },
  });
  // Read from the editor itself, at the moment it is needed: this is what gets saved.
  const currentText = () => controller.editor()?.materializeFullText() ?? "";

  // Plugins join the editor that is already running. It is never rebuilt for them, so the
  // text on screen and its undo history stay as they are when a language server arrives late.
  const [delivered, setDelivered] = createSignal<readonly EditorPlugin[]>([]);
  const added = new Set<EditorPlugin>();
  onCleanup(
    mountEditorPlugins(
      { runtime: workspace.runtime, projectRoot: PROJECT_ROOT, rootUri: `file://${PROJECT_ROOT}` },
      (plugins) => setDelivered((all) => all.concat(plugins)),
    ),
  );
  createEffect(() => {
    const editor = controller.editor();
    if (!editor) return;
    for (const plugin of delivered()) {
      if (added.has(plugin)) continue;
      added.add(plugin);
      editor.addPlugin(plugin);
    }
  });

  function place(put: () => void): void {
    placing = true;
    try {
      put();
    } finally {
      placing = false;
    }
    store.changed();
  }

  async function load(path: string): Promise<void> {
    const disk = await workspace.files.read(path);
    if (closed) return;
    const text = documents.show(path, disk, currentText);
    // Undefined: another file was selected while this one was being read.
    if (text !== undefined) place(() => setDocument(documentFor(path, text)));
  }

  createEffect(
    on(store.active, (path) => {
      if (path === undefined || path === documents.displayed) return;
      load(path).catch((error: unknown) => console.error(`Opening ${path} failed`, error));
    }),
  );

  // Saving always writes the document on screen, under the path it was read from, and only if
  // the file still holds what the editor read: a change by the shell or another tab is shown
  // as a conflict instead of being overwritten.
  async function save(): Promise<void> {
    const request = documents.beginSave();
    if (!request) return;
    const text = currentText();
    const outcome = await workspace.files.writeIfUnchanged(request.path, text, request.baseText);
    if (outcome.written) documents.saved(request, text);
    else documents.conflicted(request, outcome.current);
    store.changed();
    if (!outcome.written) return;
    // The write was acknowledged from memory. Until its flush is done the text stays
    // recoverable; only then is a copy another tab left for this file no longer needed.
    await workspace.files.saved();
    documents.durable(request, text);
    discardRecovered(localStorage, workspace.id, request.path);
  }

  const saveNow = () => void save().catch((error: unknown) => console.error("Saving failed", error));

  function keepMine(): void {
    documents.keepMine();
    store.changed();
    saveNow();
  }

  function takeTheirs(): void {
    const path = documents.displayed;
    const text = documents.takeTheirs();
    if (text === undefined || path === undefined) return;
    discardRecovered(localStorage, workspace.id, path);
    place(() => controller.commands.setText(text));
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== "s" || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    saveNow();
  }

  // Once another tab owns the workspace this tab cannot save. Everything storage does not
  // hold yet (unsaved edits, and saves whose flush never finished) is left where that tab
  // finds it.
  createEffect(() => {
    if (workspace.files.writable()) return;
    leaveForRecovery(localStorage, workspace.id, documents.unsaved(currentText));
  });

  debugHandle().editorText = () => (document() ? currentText() : "");
  // The shortcut works wherever the focus is: after picking a file it is still in the explorer.
  addEventListener("keydown", onKeyDown);
  onCleanup(() => {
    closed = true;
    removeEventListener("keydown", onKeyDown);
  });

  return (
    <section class="pane editor-pane" aria-label="Editor">
      <header class="pane-header">
        <span data-testid="editor-file">{store.displayed() ?? "No file open"}</span>
        <Show when={store.dirty()}>
          <span class="pane-status" title="Unsaved changes" data-testid="editor-dirty">
            ●
          </span>
        </Show>
      </header>
      <Show when={store.conflict()}>
        <div class="editor-conflict" role="alert" data-testid="editor-conflict">
          <span>This file changed in another tab or process. Reload from disk or keep your edits.</span>
          <button type="button" data-testid="conflict-reload" onClick={takeTheirs}>
            Reload from disk
          </button>
          <button type="button" data-testid="conflict-keep" onClick={keepMine}>
            Keep my edits
          </button>
        </div>
      </Show>
      <div class="editor-host" data-testid="editor" ref={controller.ref} />
    </section>
  );
}
