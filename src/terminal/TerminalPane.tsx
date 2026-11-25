import { createSignal, onCleanup, onMount } from "solid-js";
import { debugHandle } from "../app/debug";
import { useWorkspace } from "../workspace/session";
import { startTerminal, type SessionState, type TerminalHandle } from "./session";

export function TerminalPane() {
  const workspace = useWorkspace();
  const [state, setState] = createSignal<SessionState>("starting");
  const [failure, setFailure] = createSignal<string>();
  const [host, setHost] = createSignal<HTMLDivElement>();
  let handle: TerminalHandle | undefined;
  let closed = false;

  function onState(next: SessionState, detail?: string): void {
    setState(next);
    if (next === "failed") setFailure(detail ?? "The shell stopped unexpectedly.");
  }

  async function open(element: HTMLDivElement): Promise<void> {
    const started = await startTerminal({
      host: element,
      runtime: workspace.runtime,
      shell: workspace.shell,
      label: "Terminal",
      onState,
    });
    if (closed) return started.dispose();
    handle = started;
    debugHandle().terminalLines = started.lines;
  }

  onMount(() => {
    const element = host();
    if (!element) return;
    open(element).catch((error: unknown) => {
      setState("failed");
      setFailure(error instanceof Error ? error.message : String(error));
    });
  });

  onCleanup(() => {
    closed = true;
    void handle?.dispose();
  });

  return (
    <section class="pane terminal-pane" aria-label="Terminal">
      <header class="pane-header">
        <span>Terminal</span>
        <span class="pane-status" data-testid="terminal-state">
          {state()}
        </span>
      </header>
      <div class="terminal-host" ref={setHost} onClick={() => handle?.focus()} />
      {failure() && <p class="pane-error">{failure()}</p>}
    </section>
  );
}
