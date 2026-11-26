import { createEffect, createMemo, createSignal, For, on, onCleanup, Show, type JSX } from "solid-js";
import { createDevServer } from "../tasks/dev-server";
import { plainOutput } from "../tasks/output";
import { RESTART_LIMIT } from "../tasks/restarting";
import { trackOverflowFade } from "../ui/fade";
import { fill } from "../ui/format";
import { Icon } from "../ui/icons";
import { STATUS_SLOT } from "../workbench/slots";
import { useWorkspace } from "../workspace/session";
import { frameCommand, isFrameMessage, type FrameMessage } from "./bridge";
import { ui } from "./copy";
import { canGoBack, canGoForward, currentPath, emptyHistory, stepped, visited } from "./history";
import { BackIcon, DesktopIcon, ExternalIcon, ForwardIcon, PhoneIcon, PlayIcon, TabletIcon } from "./icons";
import { normalizePreviewPath } from "./paths";
import "./preview.css";
import { listedPorts, portLabel, samePorts, serverStatus } from "./server-status";
import type { PreviewServer } from "./transport";

type Viewport = "desktop" | "tablet" | "phone";

const VIEWPORTS: readonly { id: Viewport; label: string; icon: () => JSX.Element }[] = [
  { id: "desktop", label: ui.desktop, icon: DesktopIcon },
  { id: "tablet", label: ui.tablet, icon: TabletIcon },
  { id: "phone", label: ui.phone, icon: PhoneIcon },
];

/** A ref for a scroller that fades at an edge only while it overflows there. */
function fadeScroller(element: HTMLElement): void {
  onCleanup(trackOverflowFade(element));
}

/** How many error messages of a page are kept for the list. */
const ERROR_LIMIT = 50;

export function PreviewPane() {
  const workspace = useWorkspace();
  const { preview } = workspace;
  const devServer = createDevServer(workspace);
  // Plain signals, not a resource: a loading resource would suspend the whole workbench.
  const [usable, setUsable] = createSignal(false);
  const [unavailable, setUnavailable] = createSignal(false);
  preview.whenReady().then(
    () => setUsable(true),
    () => setUnavailable(true),
  );
  const [servers, setServers] = createSignal<readonly PreviewServer[]>(preview.servers());
  const [selected, setSelected] = createSignal<number>();
  const [history, setHistory] = createSignal(emptyHistory);
  const [draft, setDraft] = createSignal<string>();
  const [errors, setErrors] = createSignal<readonly string[]>([]);
  const [showErrors, setShowErrors] = createSignal(false);
  const [viewport, setViewport] = createSignal<Viewport>("desktop");
  const [noScript, setNoScript] = createSignal(false);
  const [frame, setFrame] = createSignal<HTMLIFrameElement>();
  /** Whether the document in the frame runs our client script and so understands commands. */
  let bridged = false;
  /** Whether the document that is loading has announced itself yet. */
  let announced = false;

  // A document that finished loading without a word from our script (an image, a download, a
  // page of another charset) cannot take commands: the frame is steered by its `src` again.
  function onFrameLoad(): void {
    if (!announced) bridged = false;
    announced = false;
  }

  function mountFrame(element: HTMLIFrameElement): void {
    setFrame(element);
    onCleanup(() => setFrame(undefined));
  }

  onCleanup(preview.subscribe(setServers));
  onCleanup(() => void devServer.dispose());

  /** Every port the pane can show: this tab's, and those of the tab that runs the dev server. */
  const ports = createMemo(
    () =>
      listedPorts(
        servers().map((server) => server.port),
        devServer.remotePorts(),
      ),
    undefined,
    { equals: samePorts },
  );
  /**
   * The server being shown: the picked one while it listens, otherwise the first one. A memo, so
   * that news about another port does not reload the page that is showing.
   */
  const port = createMemo(() => {
    const picked = selected();
    const listening = ports();
    return picked !== undefined && listening.includes(picked) ? picked : listening[0];
  });
  const path = () => currentPath(history()) ?? "/";
  /** The dev server runs in another tab, which is the only one that can stop it. */
  const elsewhere = () => devServer.status() !== "stopped" && !devServer.owned();

  // The title bar's dev server pill prints the same port as the picker here.
  createEffect(() => {
    const task = { task: devServer.status(), owned: devServer.owned(), stop: devServer.stop };
    workspace.status.set(STATUS_SLOT.devServer, serverStatus({ ...task, port: port() }));
  });
  onCleanup(() => workspace.status.set(STATUS_SLOT.devServer, undefined));

  /** Points the frame at a path of the current server, whether or not the page has a bridge. */
  function load(target: string): void {
    const active = port();
    const element = frame();
    if (active === undefined || !element) return;
    const href = preview.frameUrl(active, target);
    if (bridged)
      element.contentWindow?.postMessage(frameCommand({ command: "navigate", href }), new URL(href).origin);
    else element.src = href;
  }

  // A server appeared, was picked, or came back: start over at its root.
  createEffect(
    on([port, frame, usable], ([active, element, canLoad]) => {
      bridged = false;
      setHistory(emptyHistory);
      setErrors([]);
      setDraft(undefined);
      if (active !== undefined && element && canLoad) element.src = preview.frameUrl(active, "/");
    }),
  );

  function onFrameMessage(message: FrameMessage): void {
    if (message.type === "error") {
      setErrors((list) => list.concat([message.message]).slice(-ERROR_LIMIT));
      return;
    }
    const place = preview.locate(message.href);
    if (!place || place.port !== port()) return;
    bridged = true;
    announced = true;
    if (message.type === "started") setErrors([]);
    setHistory((current) => visited(current, place.path));
    setDraft(undefined);
  }

  function onMessage(event: MessageEvent<unknown>): void {
    const active = port();
    if (active === undefined || event.source !== frame()?.contentWindow) return;
    if (!preview.ownsOrigin(event.origin, active) || !isFrameMessage(event.data)) return;
    onFrameMessage(event.data);
  }
  addEventListener("message", onMessage);
  onCleanup(() => removeEventListener("message", onMessage));

  function step(delta: -1 | 1): void {
    const next = stepped(history(), delta);
    const target = currentPath(next);
    if (next === history() || target === undefined) return;
    setHistory(next);
    load(target);
  }

  function reload(): void {
    const element = frame();
    const active = port();
    if (!element || active === undefined) return;
    const href = preview.frameUrl(active, path());
    if (bridged)
      element.contentWindow?.postMessage(frameCommand({ command: "reload" }), new URL(href).origin);
    else element.src = href;
  }

  function submitUrl(event: SubmitEvent): void {
    event.preventDefault();
    const target = normalizePreviewPath(draft() ?? path());
    setDraft(undefined);
    load(target);
  }

  function openInNewTab(): void {
    const active = port();
    if (active !== undefined) window.open(preview.tabUrl(active, path()), "_blank", "noopener");
  }

  async function toggleDevServer(): Promise<void> {
    if (devServer.status() !== "stopped") return devServer.stop();
    setNoScript(!(await devServer.start()));
  }

  function emptyText(): string {
    if (devServer.status() === "starting") return ui.starting;
    if (devServer.ended()) return ui.serverEnded;
    return devServer.startable() ? ui.emptyStartable : ui.empty;
  }

  /** The project has something to start, and nothing of it runs or is starting. */
  const canStart = () => devServer.status() === "stopped" && devServer.startable();

  function taskLabel(): string {
    if (devServer.status() === "stopped") return ui.startServer;
    return elsewhere() ? ui.stopElsewhere : fill(ui.stopServer, { port: port() ?? "…" });
  }

  return (
    <section class="pane preview-pane" aria-label={ui.preview}>
      <form class="preview-bar" onSubmit={submitUrl} data-testid="preview-bar">
        {/* Everything that may run out of room scrolls here; the two buttons after it stay put,
            so a phone always has "open in new tab". */}
        <div class="preview-bar-scroll" data-testid="preview-bar-scroll" data-fade="" ref={fadeScroller}>
          <span class="preview-nav">
            <button
              type="button"
              class="icon-button"
              aria-label={ui.back}
              disabled={!canGoBack(history())}
              onClick={() => step(-1)}
            >
              <BackIcon />
            </button>
            <button
              type="button"
              class="icon-button"
              aria-label={ui.forward}
              disabled={!canGoForward(history())}
              onClick={() => step(1)}
            >
              <ForwardIcon />
            </button>
            <button
              type="button"
              class="icon-button"
              aria-label={ui.reload}
              disabled={port() === undefined}
              onClick={reload}
            >
              <Icon name="reload" />
            </button>
          </span>
          <label class="preview-url">
            <Icon name="globe" />
            <input
              type="text"
              aria-label={ui.url}
              data-testid="preview-url"
              spellcheck={false}
              autocomplete="off"
              disabled={port() === undefined}
              value={draft() ?? (port() === undefined ? "" : path())}
              onInput={(event) => setDraft(event.currentTarget.value)}
            />
          </label>
          {/* The port picker and the viewport switch are there once there is a page to pick or size. */}
          <Show when={ports().length > 0}>
            <select
              class="preview-port"
              aria-label={ui.switchPort}
              data-testid="preview-port"
              onChange={(event) => setSelected(Number(event.currentTarget.value))}
            >
              <For each={ports()}>
                {(listed) => (
                  <option value={listed} selected={listed === port()}>
                    {portLabel(listed)}
                  </option>
                )}
              </For>
            </select>
            <span class="preview-viewports" role="group" aria-label={ui.viewport}>
              <For each={VIEWPORTS}>
                {(option) => (
                  <button
                    type="button"
                    class="preview-viewport"
                    aria-label={option.label}
                    aria-pressed={viewport() === option.id}
                    onClick={() => setViewport(option.id)}
                  >
                    {option.icon()}
                  </button>
                )}
              </For>
            </span>
          </Show>
          <Show when={errors().length > 0}>
            <button
              type="button"
              class="preview-errors-toggle"
              data-testid="preview-errors"
              aria-expanded={showErrors()}
              aria-label={fill(ui.errors, { count: errors().length })}
              onClick={() => setShowErrors((shown) => !shown)}
            >
              <Icon name="alert" />
              <span>{errors().length}</span>
            </button>
          </Show>
        </div>
        <button
          type="button"
          class="icon-button preview-task"
          data-testid="preview-task"
          data-status={devServer.status()}
          aria-label={taskLabel()}
          disabled={elsewhere()}
          onClick={() => void toggleDevServer()}
        >
          <Show when={devServer.status() === "stopped"} fallback={<Icon name="stop" />}>
            <PlayIcon />
          </Show>
        </button>
        <button
          type="button"
          class="icon-button"
          aria-label={ui.openInTab}
          data-testid="preview-open"
          disabled={port() === undefined}
          onClick={openInNewTab}
        >
          <ExternalIcon />
        </button>
      </form>
      {/* The server runs older code than the files hold: said where the page is, not hidden. */}
      <Show when={devServer.restartHeld()}>
        <p class="preview-notice" role="status" data-testid="preview-restart-held">
          {fill(ui.restartHeld, { restarts: RESTART_LIMIT.restarts, seconds: RESTART_LIMIT.windowMs / 1000 })}
        </p>
      </Show>
      <Show when={showErrors() && errors().length > 0}>
        <ul class="preview-error-list" data-testid="preview-error-list">
          <For each={errors()}>{(message) => <li>{message}</li>}</For>
        </ul>
      </Show>
      <div class="preview-stage" data-viewport={viewport()}>
        <Show when={unavailable()}>
          <p class="pane-error">{ui.unavailable}</p>
        </Show>
        <Show when={port() === undefined && !unavailable()}>
          <div class="preview-empty" data-testid="preview-empty">
            <p>{emptyText()}</p>
            <Show when={noScript()}>
              <p>{ui.nothingToStart}</p>
            </Show>
            {/* The output stays after a server that ended by itself: it says why. */}
            <Show when={(devServer.status() === "starting" || devServer.ended()) && devServer.output()}>
              <pre class="preview-task-output" data-testid="preview-task-output">
                {plainOutput(devServer.output()).slice(-2000)}
              </pre>
            </Show>
            {/* The pane's one primary action, offered only when the project has something to start. */}
            <Show when={canStart()}>
              <button
                type="button"
                class="primary preview-start"
                data-testid="preview-start"
                onClick={() => void toggleDevServer()}
              >
                <PlayIcon />
                {ui.startServer}
              </button>
            </Show>
          </div>
        </Show>
        {/* The frame exists only while it has a page to show: a stopped server's page does not
            keep running out of sight, and the frame never sits on a blank document first. */}
        <Show when={port() !== undefined && usable()}>
          <iframe
            class="preview-frame"
            title={ui.preview}
            data-testid="preview-frame"
            onLoad={onFrameLoad}
            ref={mountFrame}
          />
        </Show>
      </div>
    </section>
  );
}
