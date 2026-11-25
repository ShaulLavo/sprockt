import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { debugHandle } from "../app/debug";
import { navigate } from "../app/router";
import { EditorPane } from "../editor/EditorPane";
import { createEditorStore } from "../editor/store";
import { Explorer } from "../explorer/Explorer";
import { PreviewPane } from "../preview/PreviewPane";
import { workspaceIsOpenElsewhere, type BootStage } from "../runtime/boot";
import { TerminalPane } from "../terminal/TerminalPane";
import { workspaceTurnstile } from "../workspace/lifecycle";
import { openWorkspace, WorkspaceContext, type WorkspaceSession } from "../workspace/session";

const STAGE_TEXT: Readonly<Record<BootStage, string>> = {
  storage: "Opening workspace storage",
  waiting: "Opening workspace storage",
  programs: "Starting runtime",
  ready: "Ready",
  moved: "Open in another tab",
};

/**
 * How long storage may stay "waiting" before the workbench says another tab has the workspace.
 * An open with nobody in the way passes through that state for a moment.
 */
const WAIT_NOTICE_MS = 500;

function Panes(props: { session: WorkspaceSession }) {
  const editor = createEditorStore(props.session);
  return (
    <WorkspaceContext.Provider value={props.session}>
      <div class="workbench-panes">
        <Explorer store={editor} />
        <EditorPane store={editor} />
        <PreviewPane />
        <TerminalPane />
      </div>
      <footer class="status-bar">
        <span data-testid="workspace-id">{props.session.id}</span>
        <span data-testid="save-state">{props.session.files.saveState()}</span>
      </footer>
    </WorkspaceContext.Provider>
  );
}

/**
 * Owns one workspace from the start of its boot to the end of its teardown. Leaving the page
 * while it boots, or while it waits for storage another tab holds, is safe: closing aborts the
 * boot, the turnstile disposes the runtime, and the next workspace waits for that.
 */
function Opened(props: { id: string; takeOver: boolean; onStage: (stage: BootStage) => void }) {
  const { id, takeOver, onStage } = props;
  const opening = workspaceTurnstile.open((signal) => openWorkspace(id, onStage, { takeOver, signal }));
  // Plain signals, not a resource: a resource that is still loading would suspend the whole
  // workbench, and a tab waiting for storage has to keep showing why it waits.
  const [session, setSession] = createSignal<WorkspaceSession>();
  const [failure, setFailure] = createSignal<string>();
  let closed = false;
  const started = (opened: WorkspaceSession): void => {
    debugHandle().workspace = opened;
    setSession(opened);
  };
  const failed = (error: unknown): void => {
    // A boot that was aborted by closing fails too; that is not an error to show.
    if (!closed) setFailure(error instanceof Error ? error.message : String(error));
  };
  opening.session.then(started, failed);
  onCleanup(() => {
    closed = true;
    void opening.close();
  });

  return (
    <Show
      when={failure() === undefined}
      fallback={
        <p class="pane-error" data-testid="boot-error">
          This workspace could not start: {failure()}
        </p>
      }
    >
      <Show when={session()}>{(opened) => <Panes session={opened()} />}</Show>
    </Show>
  );
}

/** Whether the workspace is open in another tab, asked once this page's last one is gone. */
async function openElsewhere(id: string): Promise<boolean> {
  await workspaceTurnstile.idle();
  // If storage cannot even be inspected, opening it reports the real error.
  return workspaceIsOpenElsewhere(id).catch(() => false);
}

export function Workbench(props: { id: string }) {
  const [stage, setStage] = createSignal<BootStage>("storage");
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

  return (
    <main class="workbench" data-testid="workbench" data-stage={stage()}>
      <header class="workbench-bar">
        <button type="button" class="brand" onClick={() => navigate({ kind: "landing" })}>
          Sprockt
        </button>
        <span class="workbench-stage" data-testid="boot-stage">
          {STAGE_TEXT[stage()]}
        </span>
      </header>
      {/* Opening here takes the workspace away from the other tab, so the person is asked. */}
      <Show when={busy()}>
        <div class="pane-empty" data-testid="workspace-busy">
          <p>This workspace is open in another tab.</p>
          <button type="button" class="primary" data-testid="take-over" onClick={() => setTakeOver(true)}>
            Open it here
          </button>
        </div>
      </Show>
      <Show when={starts()}>
        <Show when={takeOver()} keyed fallback={<Opened id={props.id} takeOver={false} onStage={setStage} />}>
          <Opened id={props.id} takeOver onStage={setStage} />
        </Show>
      </Show>
    </main>
  );
}
