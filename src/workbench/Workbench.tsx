// The IDE frame. Desktop: title bar, activity bar, Explorer | Editor | Preview over a Terminal,
// with drag handles between them, and a status bar. Phones and small tablets: one pane at a
// time, picked from a tab bar at the bottom. Each slice's pane mounts into its own slot here,
// and its service joins WorkspaceSession in workspace/session/index.ts.
//
// The frame's state (layout, window size, phone or not, the shown pane, the boot stage) lives in
// reactive signals, not React state: the panes' own reactive code (presence, quick open, the
// editor's "show what opened" effect) reads it, and components read it with `useValue`.
import { memo, useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { createMultiHotkeyHandler, detectPlatform } from "@shaulavo/hotkeys";
import {
  FileIconSprite,
  useKeyboardInset,
  useLongPressContextMenu,
  WorkbenchPortalProvider,
} from "@shaulavo/workbench";
import { debugHandle } from "../diagnostics/debug";
import { navigate } from "../routing/router";
import { EditorPane } from "../editor/EditorPane";
import { shouldAutoFocusEditor } from "../editor/focus-policy";
import { createEditorStore, type EditorStore } from "../editor/store";
import { Explorer } from "../explorer/Explorer";
import { Scope, useValue } from "../lib/react";
import { createEffect, createMemo, createSignal, on, onCleanup, type Accessor } from "../lib/reactive";
import { PreviewPane } from "../preview/pane/PreviewPane";
import { workspaceIsOpenElsewhere, type BootStage } from "../runtime/boot";
import { TAB_POLICY } from "../runtime/tab-policy";
import { ShareButton } from "../share/ShareButton";
import { TerminalPanel } from "../terminal/pane/TerminalPanel";
import { Icon } from "../ui/icons";
import { workspaceTurnstile } from "../workspace/lifecycle";
import { openWorkspace, WorkspaceContext, type WorkspaceSession } from "../workspace/session";
import { ActivityBar } from "./ActivityBar";
import { currentStepLabel } from "./boot-steps";
import { BootProgress } from "./BootProgress";
import { ui } from "./copy";
import { focusPane } from "./focus";
import {
  fitLayout,
  isOpen,
  setOpen,
  setTerminalState,
  toggleTerminalCollapsed,
  ariaValue,
  type Fitted,
  type PaneLayout,
  type Room,
  type Space,
  type Splitter as SplitterName,
  type TerminalState,
} from "./layout";
import { createLayoutStore, type LayoutStore } from "./layout-store";
import { PaneSwitcher, type PhonePane } from "./PaneSwitcher";
import { trackPresence } from "./presence";
import { Splitter } from "./Splitter";
import { COMMAND } from "../workspace/session/slots";
import { StatusBar } from "./StatusBar";
import { applyStoredTheme, colorScheme } from "../ui/theme";
import { TitleBar } from "./TitleBar";
import "./workbench.css";

/** Matches the phone layout in workbench.css. */
const PHONE_QUERY = "(max-width: 768px)";

function createMediaQuery(query: string): Accessor<boolean> {
  const list = matchMedia(query);
  const [matches, setMatches] = createSignal(list.matches);
  const update = (event: MediaQueryListEvent) => setMatches(event.matches);
  list.addEventListener("change", update);
  onCleanup(() => list.removeEventListener("change", update));
  return matches;
}

/**
 * The fixed parts of the desktop frame in CSS pixels, as workbench.css lays them out: the
 * activity bar and three hairline gaps across; the title bar, status bar and one gap down.
 */
const FRAME_WIDTH_PX = 46 + 3 * 1;
const FRAME_HEIGHT_PX = 42 + 24 + 1;

const paneSpace = (): Space => ({
  width: innerWidth - FRAME_WIDTH_PX,
  height: innerHeight - FRAME_HEIGHT_PX,
});

/** The space the panes share in the current window, updated as it resizes. */
function createPaneSpace(): Accessor<Space> {
  const [space, setSpace] = createSignal(paneSpace());
  const update = () => setSpace(paneSpace());
  addEventListener("resize", update);
  onCleanup(() => removeEventListener("resize", update));
  return space;
}

function terminalRowSize(layout: PaneLayout, fitted: Fitted): string {
  if (layout.terminalState === "open") return `${fitted.terminal}px`;
  if (layout.terminalState === "collapsed") return "var(--tab-h)";
  return "0px";
}

/** The frame's grid sizes as CSS custom properties: the saved layout, fitted to the window. */
function frameStyle(layout: PaneLayout, fitted: Fitted): CSSProperties {
  return {
    "--explorer-col": `${fitted.explorer}px`,
    "--preview-col": `${fitted.preview}px`,
    "--terminal-row": terminalRowSize(layout, fitted),
  } as CSSProperties;
}

/** What the frame shares with the panes of an open workspace. */
interface FrameState {
  readonly layout: LayoutStore;
  /** The terminal's visibility state alone, so readers skip drag frames that do not change it. */
  readonly terminalState: Accessor<TerminalState>;
  readonly phone: Accessor<boolean>;
  readonly pane: Accessor<PhonePane>;
  readonly stage: Accessor<BootStage>;
  readonly dragging: Accessor<boolean>;
  /** The space the panes share, and the saved layout fitted into it. */
  readonly space: Accessor<Space>;
  readonly fitted: Accessor<Fitted>;
  setPane(pane: PhonePane): void;
  setStage(stage: BootStage): void;
  setDragging(dragging: boolean): void;
}

/** Created once per workbench, in a scope that ends when it unmounts. */
function createFrame(workspaceId: string): FrameState {
  applyStoredTheme();
  const [stage, setStage] = createSignal<BootStage>("storage");
  const [pane, setPane] = createSignal<PhonePane>("files");
  const [dragging, setDragging] = createSignal(false);
  const layout = createLayoutStore(workspaceId);
  const space = createPaneSpace();
  return {
    layout,
    terminalState: createMemo(() => layout.layout().terminalState),
    phone: createMediaQuery(PHONE_QUERY),
    pane,
    stage,
    dragging,
    space,
    fitted: createMemo(() => fitLayout(layout.layout(), space())),
    setPane: (next) => void setPane(next),
    setStage: (next) => void setStage(next),
    setDragging: (next) => void setDragging(next),
  };
}

/** What one open workspace's panes own: created when they mount, disposed when they unmount. */
interface PaneScope {
  readonly editor: EditorStore;
  readonly explorerStore: EditorStore;
  readonly tabs: Accessor<number>;
  readonly slotRef: Readonly<Record<PhonePane, (element: HTMLElement | null) => void>>;
  measure(splitter: SplitterName): Room;
  shownSize(splitter: SplitterName): number;
  toggleTerminalCollapsed(): void;
}

function createPanes(session: WorkspaceSession, frame: FrameState): PaneScope {
  const editor = createEditorStore(session);
  onCleanup(
    session.terminals.onRevealRequest(() => {
      if (!frame.phone() && frame.layout.layout().terminalState !== "open") {
        frame.layout.set(setTerminalState(frame.layout.layout(), "open"));
      }
    }),
  );
  const tabs = trackPresence(session.id, () => frame.stage() !== "moved");
  const slots: Partial<Record<PhonePane, HTMLElement>> = {};
  const rect = (pane: PhonePane) => slots[pane]?.getBoundingClientRect();
  const slotRef = (pane: PhonePane) => (element: HTMLElement | null) => {
    if (element) slots[pane] = element;
    else delete slots[pane];
  };

  // On a phone, opening a file shows it: from the tree on every tap, even of the file already
  // open, and from anywhere else (quick open) when the open file changes.
  const showCode = () => {
    if (frame.phone()) frame.setPane("code");
  };
  const explorerStore: EditorStore = {
    ...editor,
    open(path, options) {
      editor.open(path, options);
      showCode();
    },
  };
  const mac = detectPlatform() === "mac";
  const showOrFocus = (pane: PhonePane) => {
    if (frame.phone()) {
      frame.setPane(pane);
    } else if (pane === "files" && !frame.layout.layout().explorerOpen) {
      frame.layout.set(setOpen(frame.layout.layout(), "explorer", true));
    } else if (pane === "preview" && !frame.layout.layout().previewOpen) {
      frame.layout.set(setOpen(frame.layout.layout(), "preview", true));
    } else if (pane === "terminal" && frame.layout.layout().terminalState !== "open") {
      frame.layout.set(setTerminalState(frame.layout.layout(), "open"));
    }
    queueMicrotask(() => {
      if (pane === "terminal") {
        const focusedTerm = session.terminals.tabs().focused;
        if (focusedTerm) {
          session.terminals.handle(focusedTerm)?.focus();
          return;
        }
      }
      focusPane(pane);
    });
  };
  const togglePane = (splitter: SplitterName, slot: PhonePane) => {
    if (frame.phone()) {
      frame.setPane(frame.pane() === slot ? "code" : slot);
      return;
    }
    const current = frame.layout.layout();
    const nextOpen = !isOpen(current, splitter);
    frame.layout.set(setOpen(current, splitter, nextOpen));
    queueMicrotask(() => {
      if (nextOpen && slot === "terminal") {
        const focusedTerm = session.terminals.tabs().focused;
        if (focusedTerm) {
          session.terminals.handle(focusedTerm)?.focus();
          return;
        }
      }
      focusPane(nextOpen ? slot : "code");
    });
  };
  // The title bar's search field and the phone's search button open the editor's quick open.
  onCleanup(
    session.commands.register(COMMAND.quickOpen, {
      label: ui.search.quickOpen,
      shortcut: mac ? "⌘P" : "Ctrl P",
      run: () => {
        showCode();
        editor.setQuickOpen(true);
      },
    }),
  );
  onCleanup(
    session.commands.register(COMMAND.toggleExplorer, {
      label: ui.workbench.toggleExplorer,
      shortcut: mac ? "⌘B" : "Ctrl B",
      icon: "sidebar-left",
      run: () => togglePane("explorer", "files"),
    }),
  );
  onCleanup(
    session.commands.register(COMMAND.toggleTerminal, {
      label: ui.workbench.toggleTerminal,
      shortcut: mac ? "⌘J" : "Ctrl J",
      icon: "panel-bottom",
      run: () => togglePane("terminal", "terminal"),
    }),
  );
  onCleanup(
    session.commands.register(COMMAND.togglePreview, {
      label: ui.workbench.togglePreview,
      icon: "sidebar-right",
      run: () => togglePane("preview", "preview"),
    }),
  );
  onCleanup(
    session.commands.register(COMMAND.focusExplorer, {
      label: ui.workbench.focusExplorer,
      shortcut: mac ? "⇧⌘E" : "Ctrl Shift E",
      icon: "files",
      run: () => showOrFocus("files"),
    }),
  );
  onCleanup(
    session.commands.register(COMMAND.focusEditor, {
      label: ui.workbench.focusEditor,
      shortcut: mac ? "⌘1" : "Ctrl 1",
      icon: "code",
      run: () => showOrFocus("code"),
    }),
  );
  onCleanup(
    session.commands.register(COMMAND.focusTerminal, {
      label: ui.workbench.focusTerminal,
      shortcut: mac ? "⌘3" : "Ctrl 3",
      icon: "terminal",
      run: () => showOrFocus("terminal"),
    }),
  );

  // Workbench-wide pane shortcuts in capture phase so they work from every pane including the terminal,
  // while leaving bare Ctrl+B and Ctrl+J with Ghostty on Linux/Windows so bash/readline keeps them.
  const handleWorkbenchKey = createMultiHotkeyHandler({
    "Mod+B": () => togglePane("explorer", "files"),
    "Mod+J": () => togglePane("terminal", "terminal"),
    "Control+`": () => togglePane("terminal", "terminal"),
    "Mod+Shift+E": () => showOrFocus("files"),
    "Mod+1": () => showOrFocus("code"),
    "Mod+2": () => showOrFocus("preview"),
    "Mod+3": () => showOrFocus("terminal"),
  });
  const onWorkbenchKeyDown = (event: KeyboardEvent) => {
    const key = event.key.toLowerCase();
    const isShellCtrlChord =
      !mac &&
      event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.shiftKey &&
      (key === "b" || key === "j");
    const inTerminal =
      event.target instanceof Element &&
      event.target.closest(".wb-terminal-view, [data-slot='terminal']") !== null;
    if (isShellCtrlChord && inTerminal) return;
    handleWorkbenchKey(event);
  };
  window.addEventListener("keydown", onWorkbenchKeyDown, true);
  onCleanup(() => window.removeEventListener("keydown", onWorkbenchKeyDown, true));
  createEffect(
    on(
      editor.active,
      (path) => {
        if (path) showCode();
      },
      { defer: true },
    ),
  );

  return {
    editor,
    explorerStore,
    tabs,
    slotRef: {
      files: slotRef("files"),
      code: slotRef("code"),
      preview: slotRef("preview"),
      terminal: slotRef("terminal"),
    },
    /** The room a handle's pane shares, measured once per drag or key press. */
    measure(splitter) {
      if (splitter === "preview")
        return { extent: (rect("code")?.width ?? 0) + (rect("preview")?.width ?? 0) };
      if (splitter === "terminal") {
        return { extent: (rect("code")?.height ?? 0) + (rect("terminal")?.height ?? 0) };
      }
      return { extent: innerWidth };
    },
    /** A pane's size on screen; 0 when closed or minimized. */
    shownSize(splitter) {
      const current = frame.layout.layout();
      if (splitter === "terminal") {
        return current.terminalState === "open" ? (rect("terminal")?.height ?? 0) : 0;
      }
      if (!isOpen(current, splitter)) return 0;
      if (splitter === "explorer") return rect("files")?.width ?? 0;
      return rect("preview")?.width ?? 0;
    },
    toggleTerminalCollapsed() {
      frame.layout.set(toggleTerminalCollapsed(frame.layout.layout()));
    },
  };
}

/** A resize handle. It reads the fitted sizes itself, so a drag re-renders only the handles. */
function Handle(props: {
  splitter: SplitterName;
  label: string;
  controls: PhonePane;
  frame: FrameState;
  panes: PaneScope;
}) {
  const { splitter, frame, panes } = props;
  const valueNow = useValue(() => ariaValue(frame.fitted(), splitter, frame.space()));
  return (
    <Splitter
      splitter={splitter}
      label={props.label}
      controls={`wb-slot-${props.controls}`}
      store={frame.layout}
      measureSpace={frame.space}
      measureSize={() => panes.shownSize(splitter)}
      valueNow={valueNow}
      onDragging={frame.setDragging}
    />
  );
}

/** The phone tab bar, reading the dirty mark itself so an edit re-renders only the bar. */
function PhoneTabs(props: { frame: FrameState; editor: EditorStore }) {
  const pane = useValue(props.frame.pane);
  const dirty = useValue(props.editor.dirty);
  return <PaneSwitcher pane={pane} onPick={props.frame.setPane} dirty={dirty} />;
}

function PanesBody(props: { session: WorkspaceSession; frame: FrameState; panes: PaneScope }) {
  const { session, frame, panes } = props;
  const phone = useValue(frame.phone);
  const pane = useValue(frame.pane);
  const terminalState = useValue(frame.terminalState);

  const slot = (name: PhonePane) => ({
    id: `wb-slot-${name}`,
    ref: panes.slotRef[name],
    "data-slot": name,
    "data-shown": pane === name ? "" : undefined,
  });
  const handle = (splitter: SplitterName, label: string, controls: PhonePane) => (
    <Handle splitter={splitter} label={label} controls={controls} frame={frame} panes={panes} />
  );

  return (
    <WorkspaceContext.Provider value={session}>
      <div className="wb-slot wb-explorer" {...slot("files")}>
        <Explorer store={panes.explorerStore} />
      </div>
      {handle("explorer", ui.workbench.resizeExplorer, "files")}
      <div className="wb-slot wb-editor wb-card" {...slot("code")}>
        <EditorPane store={panes.editor} />
      </div>
      {handle("preview", ui.workbench.resizePreview, "preview")}
      <div className="wb-slot wb-preview wb-card" {...slot("preview")}>
        <PreviewPane />
      </div>
      {handle("terminal", ui.workbench.resizeTerminal, "terminal")}
      <div className="wb-slot wb-terminal wb-card" {...slot("terminal")}>
        <TerminalPanel
          scheme={colorScheme}
          collapsed={terminalState === "collapsed" && !phone}
          shown={phone ? pane === "terminal" : terminalState !== "hidden"}
          onToggleCollapsed={panes.toggleTerminalCollapsed}
          onOpenFile={(path, location) =>
            panes.explorerStore.open(path, { ...location, focus: shouldAutoFocusEditor() })
          }
        />
      </div>
      <StatusBar tabs={panes.tabs} />
      <PhoneTabs frame={frame} editor={panes.editor} />
    </WorkspaceContext.Provider>
  );
}

/**
 * Owns one workspace from the start of its boot to the end of its teardown. Leaving the page
 * while it boots, or while it waits for storage another tab holds, is safe: closing aborts the
 * boot, the turnstile disposes the runtime, and the next workspace waits for that.
 *
 * The open and its close are one effect: every props here are fixed for the component's life
 * (the workbench gives a take-over a new key), so it runs once per mount and opens exactly one
 * runtime, and unmounting closes it. On unmount React runs this cleanup before the panes' own;
 * the runtime still goes last, because closing awaits the session before it disposes anything.
 */
const Opened = memo(function Opened(props: {
  id: string;
  takeOver: boolean;
  frame: FrameState;
  onSession(session: WorkspaceSession | undefined): void;
}) {
  const { id, takeOver, frame, onSession } = props;
  // Plain state, not Suspense: a boot still loading would suspend the whole workbench, and a tab
  // waiting for storage has to keep showing why it waits.
  const [session, setSession] = useState<WorkspaceSession>();
  const [failure, setFailure] = useState<string>();
  const stage = useValue(frame.stage);

  useEffect(() => {
    const opening = workspaceTurnstile.open((signal) =>
      openWorkspace(id, frame.setStage, { takeOver, signal }),
    );
    let closed = false;
    const started = (opened: WorkspaceSession): void => {
      if (closed) return;
      debugHandle().workspace = opened;
      setSession(opened);
      onSession(opened);
    };
    const failed = (error: unknown): void => {
      // A boot that was aborted by closing fails too; that is not an error to show.
      if (!closed) setFailure(error instanceof Error ? error.message : String(error));
    };
    opening.session.then(started, failed);
    return () => {
      closed = true;
      onSession(undefined);
      void opening.close();
    };
  }, [id, takeOver, frame, onSession]);

  if (failure !== undefined) return <BootProgress workspaceId={id} stage={stage} error={failure} />;
  if (!session) return <BootProgress workspaceId={id} stage={stage} />;
  return (
    <Scope
      create={() => createPanes(session, frame)}
      fallback={<BootProgress workspaceId={id} stage={stage} />}
    >
      {(panes) => <PanesBody session={session} frame={frame} panes={panes} />}
    </Scope>
  );
});

/** Whether the workspace is open in another tab, asked once this page's last one is gone. */
async function openElsewhere(id: string): Promise<boolean> {
  await workspaceTurnstile.idle();
  // If storage cannot even be inspected, opening it reports the real error.
  return workspaceIsOpenElsewhere(id).catch(() => false);
}

/**
 * How long storage may stay "waiting" before the workbench says another tab has the workspace.
 * An open with nobody in the way passes through that state for a moment.
 */
const WAIT_NOTICE_MS = 500;

function Notice(props: {
  text: string;
  testId: string;
  action: string;
  actionTestId?: string;
  onAction(): void;
}) {
  return (
    <div className="wb-notice" role="alert">
      <p data-testid={props.testId}>{props.text}</p>
      <button
        type="button"
        className="primary"
        data-testid={props.actionTestId}
        onClick={() => props.onAction()}
      >
        <Icon name="reload" />
        {props.action}
      </button>
    </div>
  );
}

/**
 * The `<main>` element and its layout attributes. It reads the layout itself, so a drag
 * re-renders this element and not the panes passed in as children.
 */
function Frame(props: { frame: FrameState; children: ReactNode }) {
  const { frame } = props;
  const [rootEl, setRootEl] = useState<HTMLElement | null>(null);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const stage = useValue(frame.stage);
  const pane = useValue(frame.pane);
  const phone = useValue(frame.phone);
  const dragging = useValue(frame.dragging);
  const layout = useValue(frame.layout.layout);
  const fitted = useValue(frame.fitted);
  const handleKeyboardChange = useCallback(
    (_insetPx: number, open: boolean) => {
      setKeyboardOpen(phone && open);
    },
    [phone],
  );
  useKeyboardInset({ onChange: handleKeyboardChange });
  useLongPressContextMenu(rootEl);
  return (
    <main
      ref={setRootEl}
      className={dragging ? "workbench is-dragging" : "workbench"}
      data-testid="workbench"
      data-wb-theme="sprockt"
      data-wb-theme-scope=""
      data-keyboard-open={phone && keyboardOpen ? "true" : undefined}
      data-stage={stage}
      data-pane={pane}
      data-explorer={layout.explorerOpen ? "open" : "closed"}
      data-preview={layout.previewOpen ? "open" : "closed"}
      data-terminal={layout.terminalState}
      style={frameStyle(layout, fitted)}
    >
      <FileIconSprite />
      <WorkbenchPortalProvider>{props.children}</WorkbenchPortalProvider>
    </main>
  );
}

const goHome = () => navigate({ kind: "landing" });

function WorkbenchBody(props: { id: string; frame: FrameState }) {
  const { id, frame } = props;
  const stage = useValue(frame.stage);
  const [session, setSession] = useState<WorkspaceSession>();
  // The quick answer, before anything is started. It can be out of date a moment later, so it
  // only decides what is shown first: an ordinary open never takes storage from another tab.
  // Undefined while the answer is still on its way.
  const [elsewhere, setElsewhere] = useState<boolean>();
  const [takeOver, setTakeOver] = useState(false);
  const [queued, setQueued] = useState(false);

  useEffect(() => void openElsewhere(id).then(setElsewhere), [id]);
  useEffect(() => {
    if (stage !== "waiting") return void setQueued(false);
    const timer = setTimeout(() => setQueued(true), WAIT_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [stage]);

  // Attached tabs share the workspace: storage that waits there (a host handing over) is not
  // another tab holding it, and there is nothing to take over.
  const busy = TAB_POLICY !== "attach" && !takeOver && (elsewhere === true || queued);
  const starts = takeOver || elsewhere === false;

  return (
    <Frame frame={frame}>
      <TitleBar
        workspaceId={id}
        session={session}
        onHome={goHome}
        // Only a session that started is shared; a failed or closed boot leaves it undefined.
        controls={session ? <ShareButton session={session} /> : null}
      />
      <ActivityBar layout={frame.layout} />
      {/* The boot stage for assistive technology and tests; the boot card shows it on screen. */}
      <span className="sr-only" role="status" data-testid="boot-stage">
        {stage === "moved" ? ui.tabs.movedShort : currentStepLabel(stage)}
      </span>
      {elsewhere === undefined ? <BootProgress workspaceId={id} stage="storage" /> : null}
      {/* Taking the workspace starts a fresh open, so the waiting one is closed first. */}
      {starts ? (
        <Opened
          key={takeOver ? "take-over" : "open"}
          id={id}
          takeOver={takeOver}
          frame={frame}
          onSession={setSession}
        />
      ) : null}
      {/* Opening here takes the workspace away from the other tab, so the person is asked. */}
      {busy ? (
        <Notice
          text={ui.tabs.busy}
          testId="workspace-busy"
          action={ui.tabs.openHere}
          actionTestId="take-over"
          onAction={() => setTakeOver(true)}
        />
      ) : null}
      {stage === "moved" ? (
        <Notice
          text={ui.tabs.moved}
          testId="moved-notice"
          action={ui.tabs.openHere}
          onAction={() => location.reload()}
        />
      ) : null}
    </Frame>
  );
}

export function Workbench(props: { id: string }) {
  return (
    <Scope create={() => createFrame(props.id)}>
      {(frame) => <WorkbenchBody id={props.id} frame={frame} />}
    </Scope>
  );
}
