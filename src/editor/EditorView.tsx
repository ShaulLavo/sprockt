// One Singapore editor for the whole pane. Tabs do not get editors of their own: switching tabs
// attaches that file's buffer session, which carries its text, undo history and carets.
import {
  createBracketMatchPlugin,
  createDocumentLinkPlugin,
  createOccurrenceHighlightPlugin,
} from "@singapore-editor/core";
import type { Editor } from "@singapore-editor/core/editor";
import { createPlugin } from "@singapore-editor/core/extensions";
import "@singapore-editor/core/style.css";
import { createEditorFindPlugin } from "@singapore-editor/find";
import "@singapore-editor/find/style.css";
import { createFoldGutterPlugin, createLineGutterPlugin } from "@singapore-editor/gutters";
import { createHighlightingPlugin } from "@singapore-editor/highlighting";
import { createTouchSelectionPlugin } from "@singapore-editor/plugin-ui/touch-selection-plugin";
import { useEditor } from "@singapore-editor/react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { debugHandle } from "../app/debug";
import { ContextMenu, type MenuItem } from "../explorer/ContextMenu";
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
import { clampRestoredScroll } from "./scroll-position";
import type { EditorStore, RevealRequest } from "./store";
import { createColorScheme, editorTheme } from "./theme";

declare module "../app/debug" {
  interface SprocktDebug {
    /** Path, 1-based line and column of the editor's caret. Undefined with no file open. */
    editorCaret?: () => { path: string; line: number; column: number } | undefined;
  }
}

const MONO =
  '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace';

const CURSOR_LINE_HIGHLIGHT = {
  gutterNumber: true,
  gutterBackground: ["fold-gutter"],
  rowBackground: true,
} as const;

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

type InputCommandRunner = (command: "copy" | "cut" | "paste") => void | Promise<void>;

function createClipboardBridgePlugin(onReady: (runner: InputCommandRunner | undefined) => void) {
  return createPlugin({
    name: "sprockt-clipboard",
    view(scope) {
      onReady((command) => scope.view.runInputCommand(command));
      scope.onDispose(() => onReady(undefined));
    },
  });
}

function createPlugins(narrow: boolean, onClipboardReady: (runner: InputCommandRunner | undefined) => void) {
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
    createBracketMatchPlugin(),
    createOccurrenceHighlightPlugin(),
    createDocumentLinkPlugin(),
    createTouchSelectionPlugin(),
    createClipboardBridgePlugin(onClipboardReady),
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

  attach(instance: Editor, buffer: Buffer, hostHeight: number): void {
    const current = this.shown;
    if (current?.buffer === buffer && current.path === buffer.path) return;
    if (current) current.buffer.scroll = instance.getScrollPosition();
    const savedScroll = buffer.scroll;
    instance.attachSession(buffer.session, {
      // A detached draft has no file, so no document id: language servers leave it alone.
      documentId: isDetached(buffer.path) ? null : `${PROJECT_ROOT}/${buffer.path}`,
      languageId: languageOf(buffer.path),
      scrollPosition: savedScroll,
    });
    // Clamp once against the attached document's real wrapped height so long wrapped lines keep their offset.
    if (savedScroll?.top !== undefined) {
      const clamped = clampRestoredScroll(savedScroll, instance.getContentHeight(), hostHeight);
      if (clamped && clamped.top !== instance.getScrollPosition().top) instance.setScrollPosition(clamped);
    }
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

  async show(instance: Editor, path: string, hostHeight: number): Promise<void> {
    const buffer = await this.store.buffers.load(path);
    // The user may have moved on, or closed the tab, while the file was being read.
    if (this.store.active() !== path) return this.store.releaseClosed();
    if (buffer) this.attach(instance, buffer, hostHeight);
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
  const runInputCommand = useRef<InputCommandRunner>(undefined);
  // Created once: a new array would make the editor replace its plugins.
  const [plugins] = useState(() =>
    createPlugins(narrow, (runner) => {
      runInputCommand.current = runner;
    }),
  );
  const [shown, setShown] = useState<Shown>();
  const [menu, setMenu] = useState<{ x: number; y: number }>();
  const hostEl = useRef<HTMLDivElement | null>(null);
  const [binding] = useState(() => new SessionBinding(store, workspace.status, setShown));
  const unmountPlugins = useRef<() => void>(undefined);

  const controller = useEditor({
    theme,
    plugins,
    fontFamily: MONO,
    fontSize: 13,
    lineHeight: 20,
    gutterLeadingInset: 8,
    scrollPastEnd: true,
    cursorLineHighlight: CURSOR_LINE_HIGHLIGHT,
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

  // Remeasure once JetBrains Mono Variable finishes loading so glyph widths match the rendered face.
  useEffect(() => {
    if (!editor || typeof document.fonts?.ready?.then !== "function") return;
    let disposed = false;
    void (async () => {
      await document.fonts.ready;
      if (!disposed) editor.setFontFamily(MONO);
    })();
    return () => {
      disposed = true;
    };
  }, [editor]);

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
    else void binding.show(editor, active, hostEl.current?.clientHeight ?? 0);
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

  function openMenuAt(x: number, y: number): void {
    if (!editor || !shown) return;
    setMenu({ x, y });
  }

  function onContextMenu(event: ReactMouseEvent<HTMLDivElement>): void {
    if (!editor || !shown) return;
    event.preventDefault();
    event.stopPropagation();
    openMenuAt(event.clientX, event.clientY);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
    if (!editor || !shown) return;
    event.preventDefault();
    const anchor = editor.getInputElement().getBoundingClientRect();
    openMenuAt(anchor.left + 12, anchor.bottom + 4);
  }

  function editorMenuItems(): MenuItem[] {
    if (!editor) return [];
    const instance = editor;
    const runClipboard = (command: "cut" | "copy" | "paste") => {
      const runner = runInputCommand.current;
      if (runner) void Promise.resolve(runner(command)).catch(() => {});
      else instance.dispatchCommand(command);
      instance.focus();
    };
    const items: MenuItem[] = [];
    if (writable) {
      items.push({
        label: EDITOR_COPY.editorMenu.cut,
        testId: "editor-menu-cut",
        run: () => runClipboard("cut"),
      });
    }
    items.push({
      label: EDITOR_COPY.editorMenu.copy,
      testId: "editor-menu-copy",
      run: () => runClipboard("copy"),
    });
    if (writable) {
      items.push({
        label: EDITOR_COPY.editorMenu.paste,
        testId: "editor-menu-paste",
        run: () => runClipboard("paste"),
      });
    }
    items.push(
      {
        label: EDITOR_COPY.editorMenu.selectAll,
        testId: "editor-menu-select-all",
        run: () => {
          instance.dispatchCommand("selectAll");
          instance.focus();
        },
      },
      {
        label: EDITOR_COPY.editorMenu.find,
        testId: "editor-menu-find",
        run: () => void instance.openFind(),
      },
      {
        label: EDITOR_COPY.editorMenu.goToDefinition,
        testId: "editor-menu-definition",
        run: () => {
          instance.dispatchCommand("editor.action.goToDefinition");
          instance.focus();
        },
      },
    );
    return items;
  }

  const hostRef = (element: HTMLDivElement | null) => {
    hostEl.current = element;
    return ref(element);
  };

  return (
    <>
      <div
        className="editor-host"
        data-testid="editor"
        ref={hostRef}
        onBlur={onFocusOut}
        onContextMenu={onContextMenu}
        onKeyDown={onKeyDown}
      />
      {menu ? (
        <ContextMenu
          key={`${menu.x}:${menu.y}`}
          x={menu.x}
          y={menu.y}
          label={EDITOR_COPY.editorMenu.label}
          items={editorMenuItems()}
          onClose={(escaped) => {
            setMenu(undefined);
            if (escaped) editor?.focus();
          }}
        />
      ) : null}
    </>
  );
}
