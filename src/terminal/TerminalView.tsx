// One terminal tab's screen: starts its shell on mount, stops it on unmount, and follows the
// workbench theme. Hidden tabs keep running; Ghostty refits a tab when it is shown again.
import { createEffect, createSignal, on, onCleanup, onMount, Show, type Accessor } from "solid-js";
import { useWorkspace } from "../workspace/session";
import { ui } from "./copy";
import { startTerminal, type TerminalHandle } from "./session";
import { terminalAppearance } from "./theme";

export type ViewPosition = "single" | "left" | "right" | "hidden";

export interface TerminalViewProps {
  readonly id: string;
  readonly position: ViewPosition;
  readonly scheme: Accessor<"light" | "dark">;
  readonly label: string;
  /** Called once the shell has started, so the panel can focus it if the user asked to. */
  onAttached(id: string): void;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function TerminalView(props: TerminalViewProps) {
  const { terminals, runtime, shell } = useWorkspace();
  const [failure, setFailure] = createSignal<string>();
  const closing = new AbortController();
  let host: HTMLDivElement | undefined;
  let handle: TerminalHandle | undefined;

  /** Failures after the tab closed are the closing itself, not something to show. */
  function report(error: unknown): void {
    if (closing.signal.aborted) return;
    setFailure(message(error));
  }

  function runStartupCommand(): void {
    if (!handle || terminals.stateOf(props.id) !== "ready") return;
    const command = terminals.takeCommand(props.id);
    if (command) handle.submit(command).catch(report);
  }

  async function open(element: HTMLDivElement): Promise<void> {
    const started = await startTerminal({
      host: element,
      runtime,
      shell,
      label: props.label,
      appearance: terminalAppearance(element, props.scheme()),
      signal: closing.signal,
      onState(state, detail) {
        if (closing.signal.aborted) return;
        terminals.setState(props.id, state);
        if (state === "failed") setFailure(detail ?? ui.shellStopped);
        runStartupCommand();
      },
      onTitle: (title) => terminals.setShellTitle(props.id, title),
    });
    if (closing.signal.aborted) return started.dispose();
    handle = started;
    terminals.attach(props.id, started);
    runStartupCommand();
    props.onAttached(props.id);
  }

  onMount(() => {
    if (!host) return;
    open(host).catch((error: unknown) => {
      if (closing.signal.aborted) return;
      terminals.setState(props.id, "failed");
      report(error);
    });
  });

  createEffect(
    on(props.scheme, (scheme) => host && handle?.setAppearance(terminalAppearance(host, scheme)), {
      defer: true,
    }),
  );

  onCleanup(() => {
    closing.abort(new Error("The terminal tab was closed."));
    terminals.attach(props.id, undefined);
    // The view is freed even when the shell fails to stop, and a closed tab has nowhere to
    // show that failure.
    handle?.dispose().catch(() => {});
  });

  return (
    <div
      class="term-view"
      data-position={props.position}
      data-terminal={props.id}
      onPointerDown={() => terminals.select(props.id)}
    >
      <div class="term-canvas" ref={(element) => (host = element)} />
      <Show when={failure()}>{(text) => <p class="pane-error term-failure">{text()}</p>}</Show>
    </div>
  );
}
