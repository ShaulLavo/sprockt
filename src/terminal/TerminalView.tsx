// One terminal tab's screen: starts its shell on mount, stops it on unmount, and follows the
// workbench theme. Hidden tabs keep running; Ghostty refits a tab when it is shown again.
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useValue } from "../lib/react";
import type { Accessor } from "../lib/reactive";
import { useWorkspace, type WorkspaceSession } from "../workspace/session";
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

interface MountOptions {
  readonly id: string;
  readonly label: string;
  readonly scheme: "light" | "dark";
  readonly session: Pick<WorkspaceSession, "terminals" | "runtime" | "shell">;
  /** Holds the started shell for the theme effect. */
  readonly handle: { current: TerminalHandle | undefined };
  setFailure(text: string): void;
  onAttached(id: string): void;
}

/**
 * Starts one shell on `host` and returns what stops it. Stopping is idempotent: the first call
 * aborts a start still in flight, detaches the shell from the store and frees its screen.
 */
function mountTerminal(host: HTMLDivElement, options: MountOptions): () => void {
  const { id, session } = options;
  const { terminals } = session;
  const closing = new AbortController();

  /** Failures after the tab closed are the closing itself, not something to show. */
  function report(error: unknown): void {
    if (closing.signal.aborted) return;
    options.setFailure(message(error));
  }

  function runStartupCommand(): void {
    const handle = options.handle.current;
    if (!handle || terminals.stateOf(id) !== "ready") return;
    const command = terminals.takeCommand(id);
    if (command) handle.submit(command).catch(report);
  }

  async function open(): Promise<void> {
    const started = await startTerminal({
      host,
      runtime: session.runtime,
      shell: session.shell,
      label: options.label,
      appearance: terminalAppearance(host, options.scheme),
      signal: closing.signal,
      onState(state, detail) {
        if (closing.signal.aborted) return;
        terminals.setState(id, state);
        if (state === "failed") options.setFailure(detail ?? ui.shellStopped);
        runStartupCommand();
      },
      onTitle: (title) => terminals.setShellTitle(id, title),
    });
    if (closing.signal.aborted) return started.dispose();
    options.handle.current = started;
    terminals.attach(id, started);
    runStartupCommand();
    options.onAttached(id);
  }

  open().catch((error: unknown) => {
    if (closing.signal.aborted) return;
    terminals.setState(id, "failed");
    report(error);
  });

  return () => {
    if (closing.signal.aborted) return;
    closing.abort(new Error("The terminal tab was closed."));
    terminals.attach(id, undefined);
    const handle = options.handle.current;
    options.handle.current = undefined;
    // The view is freed even when the shell fails to stop, and a closed tab has nowhere to
    // show that failure.
    handle?.dispose().catch(() => {});
  };
}

export function TerminalView(props: TerminalViewProps) {
  const session = useWorkspace();
  const { terminals } = session;
  const [failure, setFailure] = useState<string>();
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<TerminalHandle | undefined>(undefined);
  const scheme = useValue(props.scheme);
  const attached = useEffectEvent((id: string) => props.onAttached(id));

  // One shell per mount. The id is the view's key, and the label and scheme are only the starting
  // values: renames and theme changes reach a running shell another way.
  useEffect(() => {
    if (!host.current) return;
    return mountTerminal(host.current, {
      id: props.id,
      label: props.label,
      scheme: props.scheme(),
      session,
      handle,
      setFailure,
      onAttached: attached,
    });
  }, []);

  useEffect(() => {
    if (host.current) handle.current?.setAppearance(terminalAppearance(host.current, scheme));
  }, [scheme]);

  return (
    <div
      className="term-view"
      data-position={props.position}
      data-terminal={props.id}
      onPointerDown={() => terminals.select(props.id)}
    >
      <div className="term-canvas" ref={host} />
      {failure ? <p className="pane-error term-failure">{failure}</p> : null}
    </div>
  );
}
