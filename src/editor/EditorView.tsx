// One persistent Singapore editor over @shaulavo/workbench/editor's unified CodeEditor.
// Switching tabs attaches that file's buffer session, preserving text, undo history, carets, and scroll.
import { useViewportMode } from "@shaulavo/workbench";
import {
  CodeEditor,
  languageIdForPath,
  languageLabelForPath,
  type EditorRevealTarget,
  type EditorSessionAttachment,
} from "@shaulavo/workbench/editor";
import type { Editor, EditorScrollPosition } from "@singapore-editor/core/editor";
import { createPlugin } from "@singapore-editor/core/extensions";
import "@singapore-editor/core/style.css";
import "@singapore-editor/find/style.css";
import {
  useCallback,
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
import { useValue } from "../lib/react";
import { STATUS_SLOT, type StatusItems } from "../workbench/slots";
import { PROJECT_ROOT, projectRelative } from "../workspace/paths";
import { useWorkspace } from "../workspace/session";
import { isDetached, originalPath, type Buffer } from "./buffers";
import { EDITOR_COPY, fill } from "./copy";
import { shouldAutoFocusEditor } from "./focus-policy";
import { mountEditorPlugins } from "./plugins";
import type { EditorStore } from "./store";

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

const FOLD_ICONS = {
  expandedIcon: {
    kind: "svg" as const,
    viewBox: "0 0 16 16",
    path: "M3.2 5.6 8 10.4l4.8-4.8 1 1L8 12.4 2.2 6.6z",
  },
  collapsedIcon: {
    kind: "svg" as const,
    viewBox: "0 0 16 16",
    path: "M5.6 3.2 10.4 8l-4.8 4.8 1 1L12.4 8 6.6 2.2z",
  },
};

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

interface ShownBuffer {
  readonly buffer: Buffer;
  /** The path under which the buffer was attached; a rename updates buffer.path and re-attaches. */
  readonly path: string;
}

function caretOf(shown: ShownBuffer, editor: Editor) {
  const head = editor.getSelections()[0]?.headOffset ?? 0;
  const snapshot = shown.buffer.session.getTextSnapshot();
  const line = snapshot.lineAt(head);
  return { path: shown.path, line: line + 1, column: head - snapshot.lineStart(line) + 1 };
}

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

function updateStatusBar(status: StatusItems, shown: ShownBuffer | undefined, editor: Editor | null): void {
  const position = shown && editor ? caretOf(shown, editor) : undefined;
  status.set(
    STATUS_SLOT.cursor,
    position ? { text: fill(EDITOR_COPY.cursorPosition, position), side: "end", order: 10 } : undefined,
  );
  status.set(
    STATUS_SLOT.language,
    shown ? { text: languageLabelForPath(originalPath(shown.path)), side: "end", order: 11 } : undefined,
  );
}

function buildEditorMenuItems(
  editor: Editor,
  writable: boolean,
  runInputCommand: InputCommandRunner | undefined,
): MenuItem[] {
  const runClipboard = (command: "cut" | "copy" | "paste") => {
    if (runInputCommand) void Promise.resolve(runInputCommand(command)).catch(() => {});
    else editor.dispatchCommand(command);
    editor.focus();
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
        editor.dispatchCommand("selectAll");
        editor.focus();
      },
    },
    {
      label: EDITOR_COPY.editorMenu.find,
      testId: "editor-menu-find",
      run: () => void editor.openFind(),
    },
    {
      label: EDITOR_COPY.editorMenu.goToDefinition,
      testId: "editor-menu-definition",
      run: () => {
        editor.dispatchCommand("editor.action.goToDefinition");
        editor.focus();
      },
    },
  );
  return items;
}

export function EditorView(props: { store: EditorStore; onEditor?: (editor: Editor) => void }) {
  const { store, onEditor } = props;
  const workspace = useWorkspace();
  const narrow = useViewportMode() === "phone";
  const writable = useValue(workspace.files.writable);
  const active = useValue(store.active);
  const reveal = useValue(store.reveal);
  const runInputCommand = useRef<InputCommandRunner>(undefined);
  const [extraPlugins] = useState(() => [
    createClipboardBridgePlugin((runner) => {
      runInputCommand.current = runner;
    }),
  ]);
  const [editor, setEditor] = useState<Editor | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const [loaded, setLoaded] = useState<ShownBuffer>();
  const shownRef = useRef<ShownBuffer | undefined>(undefined);
  const [menu, setMenu] = useState<{ x: number; y: number }>();
  const unmountPlugins = useRef<() => void>(undefined);

  // Load the active file's buffer, guarding against stale loads when tabs change mid-read.
  useEffect(() => {
    if (active === undefined) {
      setLoaded(undefined);
      return;
    }
    let cancelled = false;
    const target = active;
    async function loadActive(): Promise<void> {
      const buffer = await store.buffers.load(target);
      if (cancelled || store.active() !== target) {
        store.releaseClosed();
        return;
      }
      if (!buffer) {
        store.close(target);
        return;
      }
      setLoaded({ buffer, path: buffer.path });
    }
    void loadActive();
    return () => {
      cancelled = true;
    };
  }, [active, store]);

  const attachment = useMemo((): EditorSessionAttachment | null => {
    if (!loaded || active === undefined) return null;
    const path = loaded.path;
    return {
      session: loaded.buffer.session,
      // A detached draft has no file on disk, so no document id: language servers leave it alone.
      documentId: isDetached(path) ? null : `${PROJECT_ROOT}/${path}`,
      languageId: languageIdForPath(originalPath(path)),
      scrollPosition: loaded.buffer.scroll,
    };
  }, [active, loaded]);

  const revealTarget = useMemo((): EditorRevealTarget | null => {
    if (!reveal || !loaded || loaded.path !== reveal.path) return null;
    return {
      line: reveal.line,
      column: reveal.column,
      focus: reveal.focus ?? shouldAutoFocusEditor(),
      seq: reveal.seq,
    };
  }, [loaded, reveal]);

  // Layout effect so LSP cleanup runs before the controller disposes Singapore's editor.
  useLayoutEffect(() => {
    if (!editor) return;
    const unmount = mountEditorPlugins(
      {
        runtime: workspace.runtime,
        projectRoot: PROJECT_ROOT,
        rootUri: `file://${PROJECT_ROOT}`,
        status: workspace.status,
        openFile: (path, position) => openProjectFile(store, path, position),
      },
      editor,
    );
    unmountPlugins.current = unmount;
    return () => {
      unmountPlugins.current = undefined;
      unmount();
    };
  }, [editor, store, workspace.runtime, workspace.status]);

  // Once another tab owns the workspace this tab's files are not live: language servers stop.
  useEffect(() => {
    if (!writable) unmountPlugins.current?.();
  }, [editor, writable]);

  useEffect(() => {
    if (editor) onEditor?.(editor);
  }, [editor, onEditor]);

  useEffect(() => {
    return () => {
      workspace.status.set(STATUS_SLOT.cursor, undefined);
      workspace.status.set(STATUS_SLOT.language, undefined);
    };
  }, [workspace.status]);

  useEffect(() => {
    const debug = debugHandle();
    debug.editorText = () => shownRef.current?.buffer.session.materializeFullText() ?? "";
    debug.editorCaret = () => {
      const current = shownRef.current;
      const instance = editorRef.current;
      return current && instance ? caretOf(current, instance) : undefined;
    };
  }, []);

  const handleEditorReady = useCallback((instance: Editor | null) => {
    editorRef.current = instance;
    setEditor(instance);
  }, []);

  const handleBeforeDetach = useCallback((_prev: EditorSessionAttachment, scroll: EditorScrollPosition) => {
    if (shownRef.current) shownRef.current.buffer.scroll = scroll;
  }, []);

  const handleAttached = useCallback(
    (instance: Editor) => {
      if (!loaded) return;
      shownRef.current = loaded;
      updateStatusBar(workspace.status, loaded, instance);
      store.setDisplayed(loaded.path);
    },
    [loaded, store, workspace.status],
  );

  const handleDetached = useCallback(
    (instance: Editor) => {
      shownRef.current = undefined;
      updateStatusBar(workspace.status, undefined, instance);
      store.setDisplayed(undefined);
    },
    [store, workspace.status],
  );

  const handleChange = useCallback(
    (_state: unknown, instance: Editor) => {
      updateStatusBar(workspace.status, shownRef.current, instance);
    },
    [workspace.status],
  );

  // Leaving the editor (a tap on the preview, the terminal, the tree) autosaves at once.
  const onFocusOut = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    void store.flushAutosave();
  };

  function openMenuAt(x: number, y: number): void {
    if (!editor || !shownRef.current) return;
    setMenu({ x, y });
  }

  function onContextMenu(event: ReactMouseEvent<HTMLDivElement>): void {
    if (!editor || !shownRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    openMenuAt(event.clientX, event.clientY);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
    if (!editor || !shownRef.current) return;
    event.preventDefault();
    const anchor = editor.getInputElement().getBoundingClientRect();
    openMenuAt(anchor.left + 12, anchor.bottom + 4);
  }

  return (
    <>
      <CodeEditor
        session={attachment}
        readOnly={!writable}
        fontFamily={MONO}
        fontSize={13}
        lineHeight={20}
        gutterLeadingInset={8}
        scrollPastEnd
        wordWrap={narrow}
        wordWrapBreak="word"
        cursorLineHighlight={CURSOR_LINE_HIGHLIGHT}
        narrowViewport={narrow}
        foldIcons={FOLD_ICONS}
        includeMergeConflict={false}
        extraPlugins={extraPlugins}
        reveal={revealTarget}
        onBeforeDetach={handleBeforeDetach}
        onAttached={handleAttached}
        onDetached={handleDetached}
        onEditorReady={handleEditorReady}
        onChange={handleChange}
        onBlur={onFocusOut}
        onContextMenu={onContextMenu}
        onKeyDown={onKeyDown}
        hostClassName="editor-host"
        hostTestId="editor"
        emptyState={
          <p className="editor-empty" data-testid="editor-empty">
            {EDITOR_COPY.noOpenEditor}
          </p>
        }
      />
      {menu && editor ? (
        <ContextMenu
          key={`${menu.x}:${menu.y}`}
          x={menu.x}
          y={menu.y}
          label={EDITOR_COPY.editorMenu.label}
          items={buildEditorMenuItems(editor, writable, runInputCommand.current)}
          onClose={(escaped) => {
            setMenu(undefined);
            if (escaped) editor.focus();
          }}
        />
      ) : null}
    </>
  );
}
