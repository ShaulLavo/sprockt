// The IDE frame. Desktop: title bar, activity bar, Explorer | Editor | Preview over a Terminal,
// with drag handles between them, and a status bar. Phones and small tablets: one pane at a
// time, picked from a tab bar at the bottom. Each slice's pane mounts into its own slot here,
// and its service joins WorkspaceSession in workspace/session.ts.
import { createEffect, createMemo, createSignal, on, onCleanup, Show, type Accessor } from "solid-js";
import { detectPlatform } from "@shaulavo/hotkeys";
import { debugHandle } from "../app/debug";
import { navigate } from "../app/router";
import { EditorPane } from "../editor/EditorPane";
import { createEditorStore, type EditorStore } from "../editor/store";
import { Explorer } from "../explorer/Explorer";
import { attachAfterImport } from "../importer/after-import";
import { PreviewPane } from "../preview/PreviewPane";
import { workspaceIsOpenElsewhere, type BootStage } from "../runtime/boot";
import { ShareButton } from "../share/ShareButton";
import { TerminalPanel } from "../terminal/TerminalPanel";
import { Icon } from "../ui/icons";
import { workspaceTurnstile } from "../workspace/lifecycle";
import { openWorkspace, WorkspaceContext, type WorkspaceSession } from "../workspace/session";
import { ActivityBar } from "./ActivityBar";
import { currentStepLabel } from "./boot-steps";
import { BootProgress } from "./BootProgress";
import { ui } from "./copy";
import {
  fitLayout,
  isOpen,
  setOpen,
  ariaValue,
  type Fitted,
  type PaneLayout,
  type Room,
  type Space,
  type Splitter as SplitterName,
} from "./layout";
import { createLayoutStore, type LayoutStore } from "./layout-store";
import { PaneSwitcher, type PhonePane } from "./PaneSwitcher";
import { trackPresence } from "./presence";
import { Splitter } from "./Splitter";
import { COMMAND } from "./slots";
import { StatusBar } from "./StatusBar";
import { applyStoredTheme, colorScheme } from "./theme";
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
 * activity bar and three card gaps across; the title bar, status bar and one gap down.
 */
const FRAME_WIDTH_PX = 46 + 3 * 6;
const FRAME_HEIGHT_PX = 42 + 24 + 6;

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

/** The frame's grid sizes as CSS custom properties: the saved layout, fitted to the window. */
function frameStyle(layout: PaneLayout, fitted: Fitted): Record<string, string> {
  return {
    "--explorer-col": `${fitted.explorer}px`,
    "--preview-col": `${fitted.preview}px`,
    "--terminal-row": layout.terminalOpen ? `${fitted.terminal}px` : "var(--tab-h)",
  };
}

/** What the frame shares with the panes of an open workspace. */
interface FrameState {
  readonly layout: LayoutStore;
  readonly phone: Accessor<boolean>;
  readonly pane: Accessor<PhonePane>;
  readonly stage: Accessor<BootStage>;
  /** The space the panes share, and the saved layout fitted into it. */
  readonly space: Accessor<Space>;
  readonly fitted: Accessor<Fitted>;
  setPane(pane: PhonePane): void;
  setDragging(dragging: boolean): void;
}

function Panes(props: { session: WorkspaceSession; frame: FrameState }) {
  const frame = props.frame;
  const editor = createEditorStore(props.session);
  onCleanup(attachAfterImport(props.session));
  const tabs = trackPresence(props.session.id, () => frame.stage() !== "moved");
  const slots: Partial<Record<PhonePane, HTMLElement>> = {};
  const rect = (pane: PhonePane) => slots[pane]?.getBoundingClientRect();

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
  // The title bar's search field and the phone's search button open the editor's quick open.
  onCleanup(
    props.session.commands.register(COMMAND.quickOpen, {
      label: ui.search.quickOpen,
      shortcut: detectPlatform() === "mac" ? "⌘P" : "Ctrl P",
      run: () => {
        showCode();
        editor.setQuickOpen(true);
      },
    }),
  );
  createEffect(
    on(
      editor.active,
      (path) => {
        if (path) showCode();
      },
      { defer: true },
    ),
  );

  /** The room a handle's pane shares, measured once per drag or key press. */
  function measure(splitter: SplitterName): Room {
    if (splitter === "preview") return { extent: (rect("code")?.width ?? 0) + (rect("preview")?.width ?? 0) };
    if (splitter === "terminal") {
      return { extent: (rect("code")?.height ?? 0) + (rect("terminal")?.height ?? 0) };
    }
    return { extent: innerWidth };
  }

  /** A pane's size on screen; 0 when closed (a closed terminal still shows its tab strip). */
  function shownSize(splitter: SplitterName): number {
    if (!isOpen(frame.layout.layout(), splitter)) return 0;
    if (splitter === "explorer") return rect("files")?.width ?? 0;
    if (splitter === "preview") return rect("preview")?.width ?? 0;
    return rect("terminal")?.height ?? 0;
  }

  const handle = (splitter: SplitterName, label: string, controls: PhonePane) => (
    <Splitter
      splitter={splitter}
      label={label}
      controls={`wb-slot-${controls}`}
      store={frame.layout}
      measure={() => measure(splitter)}
      measureSize={() => shownSize(splitter)}
      valueNow={ariaValue(frame.fitted(), splitter, frame.space())}
      onDragging={frame.setDragging}
    />
  );

  const slot = (pane: PhonePane) => ({
    id: `wb-slot-${pane}`,
    ref: (element: HTMLElement) => void (slots[pane] = element),
    "data-slot": pane,
    "data-shown": frame.pane() === pane ? "" : undefined,
  });

  const toggleTerminal = () => {
    const layout = frame.layout.layout();
    frame.layout.set(setOpen(layout, "terminal", !layout.terminalOpen));
  };

  return (
    <WorkspaceContext.Provider value={props.session}>
      <div class="wb-slot wb-explorer" {...slot("files")}>
        <Explorer store={explorerStore} />
      </div>
      {handle("explorer", ui.workbench.resizeExplorer, "files")}
      <div class="wb-slot wb-editor wb-card" {...slot("code")}>
        <EditorPane store={editor} />
      </div>
      {handle("preview", ui.workbench.resizePreview, "preview")}
      <div class="wb-slot wb-preview wb-card" {...slot("preview")}>
        <PreviewPane />
      </div>
      {handle("terminal", ui.workbench.resizeTerminal, "terminal")}
      <div class="wb-slot wb-terminal wb-card" {...slot("terminal")}>
        <TerminalPanel
          scheme={colorScheme}
          collapsed={!frame.layout.layout().terminalOpen && !frame.phone()}
          shown={!frame.phone() || frame.pane() === "terminal"}
          onToggleCollapsed={toggleTerminal}
        />
      </div>
      <StatusBar tabs={tabs} />
      <PaneSwitcher pane={frame.pane()} onPick={frame.setPane} dirty={editor.dirty()} />
    </WorkspaceContext.Provider>
  );
}

/**
 * Owns one workspace from the start of its boot to the end of its teardown. Leaving the page
 * while it boots, or while it waits for storage another tab holds, is safe: closing aborts the
 * boot, the turnstile disposes the runtime, and the next workspace waits for that.
 */
function Opened(props: {
  id: string;
  takeOver: boolean;
  frame: FrameState;
  onStage(stage: BootStage): void;
  onSession(session: WorkspaceSession | undefined): void;
}) {
  const { id, takeOver, onStage, onSession } = props;
  const opening = workspaceTurnstile.open((signal) => openWorkspace(id, onStage, { takeOver, signal }));
  // Plain signals, not a resource: a resource that is still loading would suspend the whole
  // workbench, and a tab waiting for storage has to keep showing why it waits.
  const [session, setSession] = createSignal<WorkspaceSession>();
  const [failure, setFailure] = createSignal<string>();
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
  onCleanup(() => {
    closed = true;
    onSession(undefined);
    void opening.close();
  });

  return (
    <Show
      when={failure() === undefined}
      fallback={<BootProgress workspaceId={id} stage={props.frame.stage()} error={failure()} />}
    >
      <Show when={session()} fallback={<BootProgress workspaceId={id} stage={props.frame.stage()} />}>
        {(opened) => <Panes session={opened()} frame={props.frame} />}
      </Show>
    </Show>
  );
}

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
    <div class="wb-notice" role="alert">
      <p data-testid={props.testId}>{props.text}</p>
      <button type="button" class="primary" data-testid={props.actionTestId} onClick={() => props.onAction()}>
        <Icon name="reload" />
        {props.action}
      </button>
    </div>
  );
}

export function Workbench(props: { id: string }) {
  applyStoredTheme();
  const [stage, setStage] = createSignal<BootStage>("storage");
  const [pane, setPane] = createSignal<PhonePane>("files");
  const [dragging, setDragging] = createSignal(false);
  const [session, setSession] = createSignal<WorkspaceSession>();
  // The quick answer, before anything is started. It can be out of date a moment later, so it
  // only decides what is shown first: an ordinary open never takes storage from another tab.
  // Undefined while the answer is still on its way.
  const [elsewhere, setElsewhere] = createSignal<boolean>();
  void openElsewhere(props.id).then(setElsewhere);
  const [takeOver, setTakeOver] = createSignal(false);
  const [queued, setQueued] = createSignal(false);
  createEffect(() => {
    if (stage() !== "waiting") return void setQueued(false);
    const timer = setTimeout(() => setQueued(true), WAIT_NOTICE_MS);
    onCleanup(() => clearTimeout(timer));
  });
  const busy = () => !takeOver() && (elsewhere() === true || queued());
  const starts = () => takeOver() || elsewhere() === false;

  const layout = createLayoutStore(props.id);
  const space = createPaneSpace();
  const fitted = createMemo(() => fitLayout(layout.layout(), space()));
  const frame: FrameState = {
    layout,
    phone: createMediaQuery(PHONE_QUERY),
    pane,
    stage,
    space,
    fitted,
    setPane,
    setDragging,
  };
  const opened = (takeOverNow: boolean) => (
    <Opened id={props.id} takeOver={takeOverNow} frame={frame} onStage={setStage} onSession={setSession} />
  );

  return (
    <main
      class="workbench"
      classList={{ "is-dragging": dragging() }}
      data-testid="workbench"
      data-stage={stage()}
      data-pane={pane()}
      data-explorer={layout.layout().explorerOpen ? "open" : "closed"}
      data-preview={layout.layout().previewOpen ? "open" : "closed"}
      data-terminal={layout.layout().terminalOpen ? "open" : "closed"}
      style={frameStyle(layout.layout(), fitted())}
    >
      <TitleBar
        workspaceId={props.id}
        session={session}
        onHome={() => navigate({ kind: "landing" })}
        // Only a session that started is shared; a failed or closed boot leaves it undefined.
        controls={<Show when={session()}>{(live) => <ShareButton session={live()} />}</Show>}
      />
      <ActivityBar layout={layout} />
      {/* The boot stage for assistive technology and tests; the boot card shows it on screen. */}
      <span class="sr-only" role="status" data-testid="boot-stage">
        {stage() === "moved" ? ui.tabs.movedShort : currentStepLabel(stage())}
      </span>
      <Show when={elsewhere() === undefined}>
        <BootProgress workspaceId={props.id} stage="storage" />
      </Show>
      {/* Taking the workspace starts a fresh open, so the waiting one is closed first. */}
      <Show when={starts()}>
        <Show when={takeOver()} keyed fallback={opened(false)}>
          {opened(true)}
        </Show>
      </Show>
      {/* Opening here takes the workspace away from the other tab, so the person is asked. */}
      <Show when={busy()}>
        <Notice
          text={ui.tabs.busy}
          testId="workspace-busy"
          action={ui.tabs.openHere}
          actionTestId="take-over"
          onAction={() => setTakeOver(true)}
        />
      </Show>
      <Show when={stage() === "moved"}>
        <Notice
          text={ui.tabs.moved}
          testId="moved-notice"
          action={ui.tabs.openHere}
          onAction={() => location.reload()}
        />
      </Show>
    </main>
  );
}
