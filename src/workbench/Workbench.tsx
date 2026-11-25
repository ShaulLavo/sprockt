import {
  createEffect,
  createResource,
  createSignal,
  ErrorBoundary,
  Match,
  onCleanup,
  Show,
  Switch,
} from "solid-js";
import { debugHandle } from "../app/debug";
import { navigate } from "../app/router";
import { EditorPane } from "../editor/EditorPane";
import { takeRecovered } from "../editor/recovery";
import { createEditorStore } from "../editor/store";
import { Explorer } from "../explorer/Explorer";
import { PreviewPane } from "../preview/PreviewPane";
import { workspaceIsOpenElsewhere, type BootStage } from "../runtime/boot";
import { TerminalPane } from "../terminal/TerminalPane";
import { workspaceTurnstile } from "../workspace/lifecycle";
import { openWorkspace, WorkspaceContext, type WorkspaceSession } from "../workspace/session";

const STAGE_TEXT: Readonly<Record<BootStage, string>> = {
  storage: "Opening workspace storage",
  programs: "Starting runtime",
  ready: "Ready",
  moved: "Open in another tab",
};

function Panes(props: { session: WorkspaceSession }) {
  const editor = createEditorStore((path) => takeRecovered(localStorage, props.session.id, path));
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
 * while it boots is safe: the turnstile disposes the runtime when it arrives, and the next
 * workspace waits for that.
 */
function Opened(props: { id: string; onStage: (stage: BootStage) => void }) {
  const opening = workspaceTurnstile.open(() => openWorkspace(props.id, props.onStage));
  const [session] = createResource(() => opening.session);
  createEffect(() => {
    const opened = session();
    if (opened) debugHandle().workspace = opened;
  });
  onCleanup(() => void opening.close());

  return (
    <ErrorBoundary
      fallback={(error: unknown) => (
        <p class="pane-error" data-testid="boot-error">
          This workspace could not start: {error instanceof Error ? error.message : String(error)}
        </p>
      )}
    >
      <Show when={session()}>{(opened) => <Panes session={opened()} />}</Show>
    </ErrorBoundary>
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
  const [elsewhere] = createResource(() => props.id, openElsewhere);
  const [takeOver, setTakeOver] = createSignal(false);

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
      <Switch>
        <Match when={elsewhere.loading}>{null}</Match>
        {/* Opening here takes the workspace away from the other tab, so it is asked first. */}
        <Match when={elsewhere() && !takeOver()}>
          <div class="pane-empty" data-testid="workspace-busy">
            <p>This workspace is open in another tab.</p>
            <button type="button" class="primary" data-testid="take-over" onClick={() => setTakeOver(true)}>
              Open it here
            </button>
          </div>
        </Match>
        <Match when={true}>
          <Opened id={props.id} onStage={setStage} />
        </Match>
      </Switch>
    </main>
  );
}
