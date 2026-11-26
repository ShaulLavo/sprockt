import { useEffect, useState, type FormEvent, type ReactNode, type SyntheticEvent } from "react";
import { onCleanup } from "../lib/reactive";
import { Scope, useValue } from "../lib/react";
import { createDevServer, type DevServer } from "../tasks/dev-server";
import { plainOutput } from "../tasks/output";
import { RESTART_LIMIT } from "../tasks/restarting";
import { trackOverflowFade } from "../ui/fade";
import { fill } from "../ui/format";
import { Icon } from "../ui/icons";
import { STATUS_SLOT } from "../workbench/slots";
import { useWorkspace } from "../workspace/session";
import { frameCommand, type FrameMessage } from "./bridge";
import { ui } from "./copy";
import { createGreeting } from "./greeting";
import {
  canGoBack,
  canGoForward,
  currentPath,
  emptyHistory,
  replaced,
  stepped,
  visited,
  withoutFragment,
} from "./history";
import { BackIcon, DesktopIcon, ExternalIcon, ForwardIcon, PhoneIcon, PlayIcon, TabletIcon } from "./icons";
import { normalizePreviewPath } from "./paths";
import "./preview.css";
import { listedPorts, portLabel, serverStatus } from "./server-status";
import type { PreviewServer } from "./transport";

type Viewport = "desktop" | "tablet" | "phone";

const VIEWPORTS: readonly { id: Viewport; label: string; icon: () => ReactNode }[] = [
  { id: "desktop", label: ui.desktop, icon: DesktopIcon },
  { id: "tablet", label: ui.tablet, icon: TabletIcon },
  { id: "phone", label: ui.phone, icon: PhoneIcon },
];

/** A ref for a scroller that fades at an edge only while it overflows there. */
function fadeScroller(element: HTMLElement | null): (() => void) | undefined {
  return element ? trackOverflowFade(element) : undefined;
}

/** How many error messages of a page are kept for the list. */
const ERROR_LIMIT = 50;

/**
 * The end of the dev server's output, kept after a server that ended by itself: it says why.
 * A component of its own, so that streaming output re-renders only this block.
 */
function TaskOutput(props: { devServer: DevServer }) {
  const { devServer } = props;
  const output = useValue(() =>
    devServer.status() === "starting" || devServer.ended() ? devServer.output() : "",
  );
  if (!output) return null;
  return (
    <pre className="preview-task-output" data-testid="preview-task-output">
      {plainOutput(output).slice(-2000)}
    </pre>
  );
}

function PreviewPaneBody(props: { devServer: DevServer }) {
  const { devServer } = props;
  const workspace = useWorkspace();
  const { preview } = workspace;
  const { status, owned, ended, restartHeld, startable, remotePorts } = useValue(() => ({
    status: devServer.status(),
    owned: devServer.owned(),
    ended: devServer.ended(),
    restartHeld: devServer.restartHeld(),
    startable: devServer.startable(),
    remotePorts: devServer.remotePorts(),
  }));
  // Plain state, not a suspending promise: a loading one would suspend the whole workbench.
  const [usable, setUsable] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [servers, setServers] = useState<readonly PreviewServer[]>(() => preview.servers());
  const [selected, setSelected] = useState<number>();
  const [history, setHistory] = useState(emptyHistory);
  const [draft, setDraft] = useState<string>();
  const [errors, setErrors] = useState<readonly string[]>([]);
  const [showErrors, setShowErrors] = useState(false);
  const [viewport, setViewport] = useState<Viewport>("desktop");
  const [noScript, setNoScript] = useState(false);
  const [frame, setFrame] = useState<HTMLIFrameElement | null>(null);
  /** Whether the document in the frame runs our client script and so understands commands. */
  const [greeting] = useState(createGreeting);

  useEffect(() => {
    let cancelled = false;
    preview.whenReady().then(
      () => !cancelled && setUsable(true),
      () => !cancelled && setUnavailable(true),
    );
    return () => {
      cancelled = true;
    };
  }, [preview]);

  useEffect(() => {
    // A server may have started or stopped between the first render and this subscription.
    setServers(preview.servers());
    return preview.subscribe(setServers);
  }, [preview]);

  /** Every port the pane can show: this tab's, and those of the tab that runs the dev server. */
  const ports = listedPorts(
    servers.map((server) => server.port),
    remotePorts,
  );
  /**
   * The server being shown: the picked one while it listens, otherwise the first one. A number,
   * so that news about another port does not reload the page that is showing.
   */
  const port = selected !== undefined && ports.includes(selected) ? selected : ports[0];
  const path = currentPath(history) ?? "/";
  /** The dev server runs in another tab, which is the only one that can stop it. */
  const elsewhere = status !== "stopped" && !owned;

  // The title bar's dev server pill prints the same port as the picker here.
  useEffect(() => {
    workspace.status.set(
      STATUS_SLOT.devServer,
      serverStatus({ task: status, owned, stop: devServer.stop, port }),
    );
  }, [workspace, devServer, status, owned, port]);
  useEffect(() => () => workspace.status.set(STATUS_SLOT.devServer, undefined), [workspace]);

  // Every document that finishes loading is asked whether it takes commands. One that says
  // nothing (an image, a download, a refusal, a page of another charset, any page of a
  // transport whose pages take none) is steered by the frame's `src`.
  function onFrameLoad(event: SyntheticEvent<HTMLIFrameElement>): void {
    const id = greeting.ask();
    const element = event.currentTarget;
    const origin = URL.parse(element.src)?.origin;
    if (!preview.takesCommands || !origin) return;
    element.contentWindow?.postMessage(frameCommand({ command: "hello", id }), origin);
  }

  function onFrameMessage(message: FrameMessage): void {
    if (message.type === "error") {
      setErrors((list) => list.concat([message.message]).slice(-ERROR_LIMIT));
      return;
    }
    if (message.type === "hello") return greeting.answer(message.id);
    const place = preview.locate(message.href);
    if (!place || place.port !== port) return;
    if (message.type === "started") setErrors([]);
    setHistory((current) => visited(current, place.path));
    setDraft(undefined);
  }

  // The transport hears only this frame, and only from an origin it serves. Of this render,
  // onFrameMessage reads only `port`: watching again when it changes keeps the listener's port
  // the one on screen.
  useEffect(() => {
    if (!frame) return;
    return preview.watch(frame, onFrameMessage);
  }, [preview, frame, port]);

  // A server appeared, was picked, or came back: start over at its root.
  useEffect(() => {
    // Whatever answered before belongs to another server or another frame.
    greeting.ask();
    setHistory(emptyHistory);
    setErrors([]);
    setDraft(undefined);
    if (port !== undefined && frame && usable) frame.src = preview.frameUrl(port, "/");
  }, [preview, greeting, port, frame, usable]);

  /** Points the frame at a path of the current server, whether or not the page has a bridge. */
  function load(target: string): void {
    if (port === undefined || !frame) return;
    const href = preview.frameUrl(port, target);
    if (greeting.understood)
      frame.contentWindow?.postMessage(frameCommand({ command: "navigate", href }), new URL(href).origin);
    else frame.src = href;
  }

  function step(delta: -1 | 1): void {
    const next = stepped(history, delta);
    const target = currentPath(next);
    if (next === history || target === undefined) return;
    setHistory(next);
    load(target);
  }

  function reload(): void {
    if (!frame || port === undefined) return;
    const href = preview.frameUrl(port, path);
    if (greeting.understood)
      return frame.contentWindow?.postMessage(frameCommand({ command: "reload" }), new URL(href).origin);
    // A page that takes no commands is reloaded by its address. One that ends in a fragment
    // would only scroll there, so the page is asked for without it, in the same history entry.
    const target = withoutFragment(path);
    setHistory((current) => replaced(current, target));
    frame.src = preview.frameUrl(port, target);
  }

  function submitUrl(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const target = normalizePreviewPath(draft ?? path);
    setDraft(undefined);
    load(target);
  }

  function openInNewTab(): void {
    // Another tab's port can be known before this tab's transport can name its address.
    if (port === undefined || !usable) return;
    window.open(preview.tabUrl(port, path), "_blank", "noopener");
  }

  async function toggleDevServer(): Promise<void> {
    if (devServer.status() !== "stopped") return devServer.stop();
    setNoScript(!(await devServer.start()));
  }

  function emptyText(): string {
    if (status === "starting") return ui.starting;
    if (ended) return ui.serverEnded;
    return startable ? ui.emptyStartable : ui.empty;
  }

  /** The project has something to start, and nothing of it runs or is starting. */
  const canStart = status === "stopped" && startable;

  function taskLabel(): string {
    if (status === "stopped") return ui.startServer;
    return elsewhere ? ui.stopElsewhere : fill(ui.stopServer, { port: port ?? "…" });
  }

  return (
    <section className="pane preview-pane" aria-label={ui.preview}>
      <form className="preview-bar" onSubmit={submitUrl} data-testid="preview-bar">
        {/* Everything that may run out of room scrolls here; the two buttons after it stay put,
            so a phone always has "open in new tab". */}
        <div className="preview-bar-scroll" data-testid="preview-bar-scroll" data-fade="" ref={fadeScroller}>
          <span className="preview-nav">
            <button
              type="button"
              className="icon-button"
              aria-label={ui.back}
              disabled={!canGoBack(history)}
              onClick={() => step(-1)}
            >
              <BackIcon />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label={ui.forward}
              disabled={!canGoForward(history)}
              onClick={() => step(1)}
            >
              <ForwardIcon />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label={ui.reload}
              disabled={port === undefined}
              onClick={reload}
            >
              <Icon name="reload" />
            </button>
          </span>
          <label className="preview-url">
            <Icon name="globe" />
            <input
              type="text"
              aria-label={ui.url}
              data-testid="preview-url"
              spellCheck={false}
              autoComplete="off"
              disabled={port === undefined}
              value={draft ?? (port === undefined ? "" : path)}
              onChange={(event) => setDraft(event.currentTarget.value)}
            />
          </label>
          {/* The port picker and the viewport switch are there once there is a page to pick or size. */}
          {ports.length > 0 ? (
            <>
              <select
                className="preview-port"
                aria-label={ui.switchPort}
                data-testid="preview-port"
                value={port}
                onChange={(event) => setSelected(Number(event.currentTarget.value))}
              >
                {ports.map((listed) => (
                  <option key={listed} value={listed}>
                    {portLabel(listed)}
                  </option>
                ))}
              </select>
              <span className="preview-viewports" role="group" aria-label={ui.viewport}>
                {VIEWPORTS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className="preview-viewport"
                    aria-label={option.label}
                    aria-pressed={viewport === option.id}
                    onClick={() => setViewport(option.id)}
                  >
                    {option.icon()}
                  </button>
                ))}
              </span>
            </>
          ) : null}
          {errors.length > 0 ? (
            <button
              type="button"
              className="preview-errors-toggle"
              data-testid="preview-errors"
              aria-expanded={showErrors}
              aria-label={fill(ui.errors, { count: errors.length })}
              onClick={() => setShowErrors((shown) => !shown)}
            >
              <Icon name="alert" />
              <span>{errors.length}</span>
            </button>
          ) : null}
        </div>
        <button
          type="button"
          className="icon-button preview-task"
          data-testid="preview-task"
          data-status={status}
          aria-label={taskLabel()}
          disabled={elsewhere}
          onClick={() => void toggleDevServer()}
        >
          {status === "stopped" ? <PlayIcon /> : <Icon name="stop" />}
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={ui.openInTab}
          data-testid="preview-open"
          disabled={port === undefined || !usable}
          onClick={openInNewTab}
        >
          <ExternalIcon />
        </button>
      </form>
      {/* The server runs older code than the files hold: said where the page is, not hidden. */}
      {restartHeld ? (
        <p className="preview-notice" role="status" data-testid="preview-restart-held">
          {fill(ui.restartHeld, { restarts: RESTART_LIMIT.restarts, seconds: RESTART_LIMIT.windowMs / 1000 })}
        </p>
      ) : null}
      {showErrors && errors.length > 0 ? (
        <ul className="preview-error-list" data-testid="preview-error-list">
          {/* Messages repeat; their place in the list is what tells them apart. */}
          {errors.map((message, index) => (
            <li key={index}>{message}</li>
          ))}
        </ul>
      ) : null}
      <div className="preview-stage" data-viewport={viewport}>
        {unavailable ? <p className="pane-error">{ui.unavailable}</p> : null}
        {port === undefined && !unavailable ? (
          <div className="preview-empty" data-testid="preview-empty">
            <p>{emptyText()}</p>
            {noScript ? <p>{ui.nothingToStart}</p> : null}
            <TaskOutput devServer={devServer} />
            {/* The pane's one primary action, offered only when the project has something to start. */}
            {canStart ? (
              <button
                type="button"
                className="primary preview-start"
                data-testid="preview-start"
                onClick={() => void toggleDevServer()}
              >
                <PlayIcon />
                {ui.startServer}
              </button>
            ) : null}
          </div>
        ) : null}
        {/* The frame exists only while it has a page to show: a stopped server's page does not
            keep running out of sight, and the frame never sits on a blank document first. */}
        {port !== undefined && usable ? (
          <iframe
            className="preview-frame"
            title={ui.preview}
            data-testid="preview-frame"
            // A page on its own origin has SharedArrayBuffer only if its embedder allows it.
            allow="cross-origin-isolated"
            onLoad={onFrameLoad}
            ref={setFrame}
          />
        ) : null}
      </div>
    </section>
  );
}

export function PreviewPane() {
  const workspace = useWorkspace();
  return (
    <Scope
      create={() => {
        const server = createDevServer(workspace);
        onCleanup(() => void server.dispose());
        return server;
      }}
    >
      {(devServer) => <PreviewPaneBody devServer={devServer} />}
    </Scope>
  );
}
