// One Singapore editor for the whole pane. Tabs do not get editors of their own: switching tabs
// attaches that file's buffer session, which carries its text, undo history and carets.
import type { Editor } from "@singapore-editor/core/editor";
import "@singapore-editor/core/style.css";
import { createEditorFindPlugin } from "@singapore-editor/find";
import "@singapore-editor/find/style.css";
import { createFoldGutterPlugin, createLineGutterPlugin } from "@singapore-editor/gutters";
import { createHighlightingPlugin } from "@singapore-editor/highlighting";
import { useEditor } from "@singapore-editor/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent } from "react";
import { debugHandle } from "../app/debug";
import { useScope, useValue } from "../lib/react";
import { untrack } from "../lib/reactive";
import { STATUS_SLOT, type StatusItems } from "../workbench/slots";
import { colorScheme } from "../workbench/theme";
import { PROJECT_ROOT, projectRelative } from "../workspace/paths";
import { useWorkspace } from "../workspace/session";
import { isDetached, type Buffer } from "./buffers";
import { EDITOR_COPY, fill } from "./copy";
import { languageName, languageOf } from "./languages";
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
function useNarrow(): boolean {
  const [media] = useState(() => matchMedia("(max-width: 768px)"));
  const [narrow, setNarrow] = useState(media.matches);
  useEffect(() => {
    const update = () => setNarrow(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [media]);
  return narrow;
}

function createPlugins(narrow: boolean) {
  return [
    createLineGutterPlugin(),
    // A phone has no room for a fold column; its markers are hidden there too (editor.css).
    createFoldGutterPlugin({
      width: narrow ? 0 : 16,
      expandedIcon: FOLD_OPEN,
      collapsedIcon: FOLD_CLOSED,
    }),
    createHighlightingPlugin(),
    createEditorFindPlugin(),
  ];
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

/** Which buffer session the editor shows, and the status bar items that follow it. */
class SessionBinding {
  shown: Shown | undefined;
  private handledReveal = 0;

  constructor(
    private readonly store: EditorStore,
    private readonly status: StatusItems,
    private readonly onShown: (shown: Shown | undefined) => void,
  ) {}

  /** Cursor position and language in the status bar, for the file on screen. */
  refresh(instance: Editor | null): void {
    const current = this.shown;
    const position = current && instance ? caretOf(current, instance) : undefined;
    this.status.set(
      STATUS_SLOT.cursor,
      position ? { text: fill(EDITOR_COPY.cursorPosition, position), side: "end", order: 10 } : undefined,
    );
    this.status.set(
      STATUS_SLOT.language,
      current ? { text: languageName(current.path), side: "end", order: 11 } : undefined,
    );
  }

  clearStatus(): void {
    this.status.set(STATUS_SLOT.cursor, undefined);
    this.status.set(STATUS_SLOT.language, undefined);
  }

  private setShown(next: Shown | undefined): void {
    this.shown = next;
    this.onShown(next);
  }

  attach(instance: Editor, buffer: Buffer): void {
    const current = this.shown;
    if (current?.buffer === buffer && current.path === buffer.path) return;
    if (current) current.buffer.scroll = instance.getScrollPosition();
    instance.attachSession(buffer.session, {
      // A detached draft has no file, so no document id: language servers leave it alone.
      documentId: isDetached(buffer.path) ? null : `${PROJECT_ROOT}/${buffer.path}`,
      languageId: languageOf(buffer.path),
      scrollPosition: buffer.scroll,
    });
    this.setShown({ buffer, path: buffer.path });
    this.refresh(instance);
    this.store.setDisplayed(buffer.path);
  }

  detach(instance: Editor): void {
    const current = this.shown;
    if (!current) return;
    current.buffer.scroll = instance.getScrollPosition();
    instance.detachSession();
    this.setShown(undefined);
    this.refresh(instance);
    this.store.setDisplayed(undefined);
  }

  async show(instance: Editor, path: string): Promise<void> {
    const buffer = await this.store.buffers.load(path);
    // The user may have moved on, or closed the tab, while the file was being read.
    if (this.store.active() !== path) return this.store.releaseClosed();
    if (buffer) this.attach(instance, buffer);
    else this.store.close(path);
  }

  reveal(instance: Editor, request: RevealRequest): void {
    const current = this.shown;
    if (!current || current.path !== request.path || request.seq === this.handledReveal) return;
    this.handledReveal = request.seq;
    if (request.line !== undefined) {
      const offset = revealOffset(current.buffer, { ...request, line: request.line });
      instance.jumpTo(offset, undefined, "go-to-line");
    }
    instance.focus();
  }
}

export function EditorView(props: { store: EditorStore; onEditor?: (editor: Editor) => void }) {
  const { store, onEditor } = props;
  const workspace = useWorkspace();
  const schemeAccessor = useScope(createColorScheme);
  const scheme = useValue(() => schemeAccessor?.() ?? colorScheme());
  const narrow = useNarrow();
  const writable = useValue(workspace.files.writable);
  const active = useValue(store.active);
  const reveal = useValue(store.reveal);
  const theme = useMemo(() => editorTheme(scheme), [scheme]);
  // Created once: a new array would make the editor replace its plugins.
  const [plugins] = useState(() => createPlugins(narrow));
  const [shown, setShown] = useState<Shown>();
  const [binding] = useState(() => new SessionBinding(store, workspace.status, setShown));
  const unmountPlugins = useRef<() => void>(undefined);

  const controller = useEditor({
    theme,
    plugins,
    fontFamily: MONO,
    fontSize: 13,
    lineHeight: 20,
    gutterLeadingInset: 8,
    wordWrap: narrow,
    wordWrapBreak: "word",
    // Once another tab owns the workspace, this tab can read but no longer write.
    editability: writable ? "editable" : "readonly",
    storeSync: "none",
    // Every edit and every caret move: the status bar shows where the caret is.
    onChange: () => untrack(() => binding.refresh(controller.getEditor())),
  });
  const { ref } = controller;
  const editor = controller.useEditorInstance();

  // A layout effect, so its cleanup runs before the controller disposes the editor.
  useLayoutEffect(() => {
    if (!editor) return;
    const unmount = mountEditorPlugins(
      {
        runtime: workspace.runtime,
        projectRoot: PROJECT_ROOT,
        rootUri: `file://${PROJECT_ROOT}`,
        openFile: (path, position) => openProjectFile(store, path, position),
      },
      editor,
    );
    unmountPlugins.current = unmount;
    return () => {
      unmountPlugins.current = undefined;
      unmount();
    };
  }, [editor, store, workspace.runtime]);

  // Once another tab owns the workspace this tab's files are not live: language servers stop.
  useEffect(() => {
    if (!writable) unmountPlugins.current?.();
  }, [editor, writable]);

  useEffect(() => {
    if (editor) onEditor?.(editor);
  }, [editor, onEditor]);

  useEffect(() => {
    if (!editor) return;
    if (active === undefined) binding.detach(editor);
    else void binding.show(editor, active);
  }, [binding, editor, active]);

  useEffect(() => {
    if (editor && reveal) binding.reveal(editor, reveal);
  }, [binding, editor, reveal, shown]);

  useEffect(() => () => binding.clearStatus(), [binding]);

  useEffect(() => {
    const debug = debugHandle();
    debug.editorText = () => binding.shown?.buffer.session.materializeFullText() ?? "";
    debug.editorCaret = () => {
      const current = binding.shown;
      const instance = controller.getEditor();
      return current && instance ? caretOf(current, instance) : undefined;
    };
  }, [binding, controller]);

  // Leaving the editor (a tap on the preview, the terminal, the tree) autosaves at once.
  const onFocusOut = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    void store.flushAutosave();
  };

  return <div className="editor-host" data-testid="editor" ref={ref} onBlur={onFocusOut} />;
}
