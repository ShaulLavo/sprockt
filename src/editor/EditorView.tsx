// One Singapore editor for the whole pane. Tabs do not get editors of their own: switching tabs
// attaches that file's buffer session, which carries its text, undo history and carets.
import { Editor } from "@singapore-editor/core/editor";
import "@singapore-editor/core/style.css";
import { createEditorFindPlugin } from "@singapore-editor/find";
import "@singapore-editor/find/style.css";
import { createFoldGutterPlugin, createLineGutterPlugin } from "@singapore-editor/gutters";
import { createHighlightingPlugin } from "@singapore-editor/highlighting";
import { createEffect, createSignal, on, onCleanup, onMount } from "solid-js";
import { debugHandle } from "../app/debug";
import { PROJECT_ROOT, projectRelative } from "../workspace/paths";
import { useWorkspace } from "../workspace/session";
import type { Buffer } from "./buffers";
import { languageOf } from "./languages";
import { mountEditorPlugins } from "./plugins";
import type { EditorStore, RevealRequest } from "./store";
import { createColorScheme, editorTheme } from "./theme";

declare module "../app/debug" {
  interface SprocktDebug {
    /** Path, 1-based line and column of the editor's caret. Undefined with no file open. */
    editorCaret?: () => { path: string; line: number; column: number } | undefined;
  }
}

const MONO = '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace';

/** Fold markers are chevrons like the explorer's, down for an open region and right for a folded one. */
const FOLD_OPEN = {
  kind: "svg",
  viewBox: "0 0 16 16",
  path: "M3.2 5.6 8 10.4l4.8-4.8 1 1L8 12.4 2.2 6.6z",
} as const;
const FOLD_CLOSED = {
  kind: "svg",
  viewBox: "0 0 16 16",
  path: "M5.6 3.2 10.4 8l-4.8 4.8 1 1L12.4 8 6.6 2.2z",
} as const;

/** Phones wrap long lines to the screen instead of scrolling sideways. */
function createNarrow() {
  const media = matchMedia("(max-width: 768px)");
  const [narrow, setNarrow] = createSignal(media.matches);
  const update = () => setNarrow(media.matches);
  media.addEventListener("change", update);
  onCleanup(() => media.removeEventListener("change", update));
  return narrow;
}

interface Shown {
  readonly buffer: Buffer;
  /** The path it was attached under; a rename changes the buffer's path and needs a re-attach. */
  readonly path: string;
}

function caretOf(shown: Shown, editor: Editor) {
  const head = editor.getSelections()[0]?.headOffset ?? 0;
  const snapshot = shown.buffer.session.getTextSnapshot();
  const line = snapshot.lineAt(head);
  return { path: shown.path, line: line + 1, column: head - snapshot.lineStart(line) + 1 };
}

function revealOffset(buffer: Buffer, request: RevealRequest & { line: number }): number {
  const snapshot = buffer.session.getTextSnapshot();
  const row = Math.max(0, Math.min(request.line - 1, snapshot.lineCount - 1));
  const range = snapshot.lineRange(row);
  return Math.min(range.start + Math.max(0, (request.column ?? 1) - 1), range.end);
}

/** Opens an absolute project path in a tab, at a 1-based position when given. */
function openProjectFile(
  store: EditorStore,
  path: string,
  position?: { readonly line: number; readonly column: number },
): boolean {
  const relative = projectRelative(path);
  if (!relative) return false;
  store.open(relative, position ? { line: position.line, column: position.column } : { focus: true });
  return true;
}

export function EditorView(props: { store: EditorStore; onEditor?: (editor: Editor) => void }) {
  const workspace = useWorkspace();
  const scheme = createColorScheme();
  const narrow = createNarrow();
  const [editor, setEditor] = createSignal<Editor>();
  const [shown, setShown] = createSignal<Shown>();
  let host!: HTMLDivElement;
  let handledReveal = 0;

  onMount(() => {
    const instance = new Editor(host, {
      theme: editorTheme(scheme()),
      plugins: [
        createLineGutterPlugin(),
        createFoldGutterPlugin({ width: 16, expandedIcon: FOLD_OPEN, collapsedIcon: FOLD_CLOSED }),
        createHighlightingPlugin(),
        createEditorFindPlugin(),
      ],
      fontFamily: MONO,
      fontSize: 13,
      lineHeight: 20,
      gutterLeadingInset: 8,
      wordWrapBreak: "word",
    });
    const unmount = mountEditorPlugins(
      {
        runtime: workspace.runtime,
        projectRoot: PROJECT_ROOT,
        rootUri: `file://${PROJECT_ROOT}`,
        openFile: (path, position) => openProjectFile(props.store, path, position),
      },
      instance,
    );
    // Once another tab owns the workspace this tab's files are not live: language servers stop.
    createEffect(() => {
      if (!workspace.files.writable()) unmount();
    });
    setEditor(instance);
    props.onEditor?.(instance);
    onCleanup(() => {
      unmount();
      instance.dispose();
    });
  });

  createEffect(() => editor()?.setTheme(editorTheme(scheme())));
  createEffect(() => editor()?.setWordWrap(narrow()));
  // Once another tab owns the workspace, this tab can read but no longer write.
  createEffect(() => editor()?.setEditability(workspace.files.writable() ? "editable" : "readonly"));

  function attach(instance: Editor, buffer: Buffer): void {
    const current = shown();
    if (current?.buffer === buffer && current.path === buffer.path) return;
    if (current) current.buffer.scroll = instance.getScrollPosition();
    instance.attachSession(buffer.session, {
      documentId: `${PROJECT_ROOT}/${buffer.path}`,
      languageId: languageOf(buffer.path),
      scrollPosition: buffer.scroll,
    });
    setShown({ buffer, path: buffer.path });
    props.store.setDisplayed(buffer.path);
  }

  function detach(instance: Editor): void {
    const current = shown();
    if (!current) return;
    current.buffer.scroll = instance.getScrollPosition();
    instance.detachSession();
    setShown(undefined);
    props.store.setDisplayed(undefined);
  }

  async function show(instance: Editor, path: string): Promise<void> {
    const buffer = await props.store.buffers.load(path);
    // The user may have moved on, or closed the tab, while the file was being read.
    if (props.store.active() !== path) return props.store.releaseClosed();
    if (buffer) attach(instance, buffer);
    else props.store.close(path);
  }

  createEffect(
    on([editor, props.store.active], ([instance, path]) => {
      if (!instance) return;
      if (path === undefined) detach(instance);
      else void show(instance, path);
    }),
  );

  createEffect(() => {
    const request = props.store.reveal();
    const current = shown();
    const instance = editor();
    if (!request || !current || !instance || current.path !== request.path || request.seq === handledReveal)
      return;
    handledReveal = request.seq;
    if (request.line !== undefined) {
      const offset = revealOffset(current.buffer, { ...request, line: request.line });
      instance.jumpTo(offset, undefined, "go-to-line");
    }
    instance.focus();
  });

  const debug = debugHandle();
  debug.editorText = () => shown()?.buffer.session.materializeFullText() ?? "";
  debug.editorCaret = () => {
    const current = shown();
    const instance = editor();
    return current && instance ? caretOf(current, instance) : undefined;
  };

  return <div class="editor-host" data-testid="editor" ref={(node) => (host = node)} />;
}
