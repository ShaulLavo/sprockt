import { createResource, createSignal, ErrorBoundary, onCleanup, Show } from "solid-js";
import { debugHandle } from "../app/debug";
import { navigate } from "../app/router";
import { EditorPane } from "../editor/EditorPane";
import { createEditorStore } from "../editor/store";
import { Explorer } from "../explorer/Explorer";
import { PreviewPane } from "../preview/PreviewPane";
import type { BootStage } from "../runtime/boot";
import { TerminalPane } from "../terminal/TerminalPane";
import { openWorkspace, WorkspaceContext, type WorkspaceSession } from "../workspace/session";

const STAGE_TEXT: Readonly<Record<BootStage, string>> = {
  storage: "Opening files",
  programs: "Installing programs",
  ready: "Ready",
  moved: "Open in another tab",
};

function Panes(props: { session: WorkspaceSession }) {
  const editor = createEditorStore();
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

export function Workbench(props: { id: string }) {
  const [stage, setStage] = createSignal<BootStage>("storage");
  const [session] = createResource(
    () => props.id,
    async (id) => {
      const opened = await openWorkspace(id, setStage);
      debugHandle().workspace = opened;
      return opened;
    },
  );
  onCleanup(() => void session.latest?.dispose());

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
      <ErrorBoundary
        fallback={(error: unknown) => (
          <p class="pane-error" data-testid="boot-error">
            This workspace could not start: {error instanceof Error ? error.message : String(error)}
          </p>
        )}
      >
        <Show when={session()}>{(opened) => <Panes session={opened()} />}</Show>
      </ErrorBoundary>
    </main>
  );
}
