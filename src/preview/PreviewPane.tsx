// Preview pane: wraps @shaulavo/workbench-preview's PreviewPane over Sprockt's Waffle
// PreviewTransport and dev-server lifecycle.
import { useEffect, useMemo, useRef, useState } from "react";
import { PreviewPane as WorkbenchPreviewPane, type PreviewViewportPreset } from "@shaulavo/workbench-preview";
import "@shaulavo/workbench-preview/preview.css";
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
import { ui } from "./copy";
import { DesktopIcon, PhoneIcon, PlayIcon, TabletIcon } from "./icons";
import { portLabel, serverStatus } from "./server-status";
import { createWafflePreviewAdapter } from "./waffle-adapter";
import "./preview.css";

function fadeScroller(element: HTMLDivElement | null): (() => void) | undefined {
  return element ? trackOverflowFade(element) : undefined;
}

function viewportIcon(preset: PreviewViewportPreset) {
  if (preset === "tablet") return <TabletIcon />;
  if (preset === "mobile") return <PhoneIcon />;
  return <DesktopIcon />;
}

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

  const adapter = useMemo(() => createWafflePreviewAdapter(preview), [preview]);
  const [activePort, setActivePort] = useState<number>();
  const [noScript, setNoScript] = useState(false);
  const [serverEpoch, setServerEpoch] = useState(0);
  const hadPortRef = useRef(false);

  useEffect(() => () => adapter.dispose(), [adapter]);

  useEffect(() => {
    adapter.setRemotePorts(remotePorts);
  }, [adapter, remotePorts]);

  const elsewhere = status !== "stopped" && !owned;

  // The title bar's dev server pill prints the same port as the picker here.
  useEffect(() => {
    workspace.status.set(
      STATUS_SLOT.devServer,
      serverStatus({ task: status, owned, stop: devServer.stop, port: activePort }),
    );
  }, [workspace, devServer, status, owned, activePort]);
  useEffect(() => () => workspace.status.set(STATUS_SLOT.devServer, undefined), [workspace]);

  function handleActivePortChange(nextPort: number | undefined): void {
    setActivePort(nextPort);
    if (nextPort === undefined && hadPortRef.current) {
      hadPortRef.current = false;
      setServerEpoch((epoch) => epoch + 1);
      return;
    }
    if (nextPort !== undefined) hadPortRef.current = true;
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

  function taskLabel(): string {
    if (status === "stopped") return ui.startServer;
    return elsewhere ? ui.stopElsewhere : fill(ui.stopServer, { port: activePort ?? "…" });
  }

  const canStart = status === "stopped" && startable;

  return (
    <WorkbenchPreviewPane
      key={serverEpoch}
      adapter={adapter}
      className="pane preview-pane"
      sandbox={null}
      allow="cross-origin-isolated"
      historyMode="pane"
      errorDisplay="toggle"
      alwaysShowPortSelect
      hideViewportsWhenEmpty
      formatPortLabel={(server) => portLabel(server.port)}
      urlLabel={ui.url}
      viewportLabels={{ responsive: ui.desktop, tablet: ui.tablet, mobile: ui.phone }}
      renderViewportIcon={viewportIcon}
      openInTabLabel={ui.openInTab}
      onOpenInTab={(url) => void window.open(url, "_blank", "noopener")}
      onActivePortChange={handleActivePortChange}
      toolbarScrollRef={fadeScroller}
      toolbarTrailing={
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
      }
      banner={
        restartHeld ? (
          <p className="preview-notice" role="status" data-testid="preview-restart-held">
            {fill(ui.restartHeld, {
              restarts: RESTART_LIMIT.restarts,
              seconds: RESTART_LIMIT.windowMs / 1000,
            })}
          </p>
        ) : null
      }
      renderEmpty={({ bootError }) =>
        bootError ? (
          <p className="pane-error">{ui.unavailable}</p>
        ) : (
          <div className="preview-empty" data-testid="preview-empty">
            <p>{emptyText()}</p>
            {noScript ? <p>{ui.nothingToStart}</p> : null}
            <TaskOutput devServer={devServer} />
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
        )
      }
    />
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
