// Preview pane: wraps @shaulavo/workbench/preview's PreviewPane over Sprockt's Waffle
// PreviewTransport and dev-server lifecycle.
import { useEffect, useMemo, useState } from "react";
import type { PreviewServerInfo } from "@shaulavo/workbench/core";
import { PreviewPane as WorkbenchPreviewPane, type PreviewViewportPreset } from "@shaulavo/workbench/preview";
import { onAfterImport } from "../../importer/after-import";
import { onCleanup } from "../../lib/reactive";
import { Scope, useValue } from "../../lib/react";
import { createDevServer, type DevServer, type WorkspaceTarget } from "../../tasks/dev-server";
import { plainOutput } from "../../tasks/output";
import { RESTART_LIMIT } from "../../tasks/restarting";
import { trackOverflowFade } from "../../ui/fade";
import { fill } from "../../ui/format";
import { Icon } from "../../ui/icons";
import { STATUS_SLOT } from "../../workspace/session/slots";
import { useWorkspace } from "../../workspace/session";
import { ui } from "../copy";
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

function targetOptionLabel(target: WorkspaceTarget, targets: readonly WorkspaceTarget[]): string {
  if (!target.dir) {
    const hasWorkspaceTargets = targets.some((other) => other.dir !== "");
    return hasWorkspaceTargets ? `${target.name} · ${target.action}` : target.action;
  }
  const duplicateName = targets.some((other) => other.dir !== target.dir && other.name === target.name);
  const label = duplicateName ? target.dir : target.name;
  return `${label} · ${target.action}`;
}

function formatPreviewPort(server: PreviewServerInfo, targets: readonly WorkspaceTarget[]): string {
  if (server.label) return `${portLabel(server.port)} · ${server.label}`;
  const matching = targets.filter((target) => target.dir !== "" && target.port === server.port);
  const uniqueNames = new Set(matching.map((target) => target.name));
  if (uniqueNames.size === 1) {
    const [name] = uniqueNames;
    if (name) return `${portLabel(server.port)} · ${name}`;
  }
  return portLabel(server.port);
}

function PreviewPaneBody(props: { devServer: DevServer }) {
  const { devServer } = props;
  const workspace = useWorkspace();
  const { preview } = workspace;
  const {
    status,
    owned,
    ended,
    restartHeld,
    startable,
    remotePorts,
    targets,
    defaultTargetId,
    selectedTargetId,
    runningTargetId,
    remoteTargetId,
  } = useValue(() => ({
    status: devServer.status(),
    owned: devServer.owned(),
    ended: devServer.ended(),
    restartHeld: devServer.restartHeld(),
    startable: devServer.startable(),
    remotePorts: devServer.remotePorts(),
    targets: devServer.targets(),
    defaultTargetId: devServer.defaultTargetId(),
    selectedTargetId: devServer.selectedTargetId(),
    runningTargetId: devServer.runningTargetId(),
    remoteTargetId: devServer.remoteTargetId(),
  }));

  const adapter = useMemo(() => createWafflePreviewAdapter(preview), [preview]);
  const [activePort, setActivePort] = useState<number>();
  const [noScript, setNoScript] = useState(false);

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

  async function toggleDevServer(): Promise<void> {
    if (devServer.status() !== "stopped") return devServer.stop();
    setNoScript(!(await devServer.start()));
  }

  function handleTargetChange(nextId: string): void {
    devServer.selectTarget(nextId || undefined);
    if (devServer.status() !== "stopped" && devServer.owned()) {
      devServer.stop();
      void devServer.start();
    }
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
  const validTarget = (id: string | undefined) =>
    id && targets.some((target) => target.id === id) ? id : undefined;
  const activeTargetId =
    validTarget(runningTargetId) ??
    validTarget(remoteTargetId) ??
    validTarget(selectedTargetId) ??
    validTarget(defaultTargetId) ??
    targets[0]?.id ??
    "";
  const showTargetPicker = targets.length > 1;

  const targetPicker = showTargetPicker ? (
    <select
      className="preview-target-select"
      data-testid="preview-target-select"
      aria-label={ui.selectTarget}
      disabled={elsewhere}
      value={activeTargetId}
      onChange={(event) => handleTargetChange(event.currentTarget.value)}
    >
      {targets.map((target) => (
        <option key={target.id} value={target.id}>
          {targetOptionLabel(target, targets)}
        </option>
      ))}
    </select>
  ) : null;

  return (
    <WorkbenchPreviewPane
      adapter={adapter}
      className="pane preview-pane"
      sandbox={null}
      allow="cross-origin-isolated"
      historyMode="pane"
      errorDisplay="toggle"
      alwaysShowPortSelect
      hideViewportsWhenEmpty
      formatPortLabel={(server) => formatPreviewPort(server, targets)}
      urlLabel={ui.url}
      viewportLabels={{ responsive: ui.desktop, tablet: ui.tablet, mobile: ui.phone }}
      renderViewportIcon={viewportIcon}
      openInTab={{
        label: ui.openInTab,
        onOpen: (url) => void window.open(url, "_blank", "noopener"),
      }}
      onActivePortChange={setActivePort}
      toolbarScrollRef={fadeScroller}
      toolbarActions={
        <>
          {targetPicker}
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
        </>
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
              <div className="preview-empty-actions">
                {showTargetPicker ? (
                  <select
                    className="preview-target-select"
                    data-testid="preview-empty-target-select"
                    aria-label={ui.selectTarget}
                    value={activeTargetId}
                    onChange={(event) => devServer.selectTarget(event.currentTarget.value || undefined)}
                  >
                    {targets.map((target) => (
                      <option key={target.id} value={target.id}>
                        {targetOptionLabel(target, targets)}
                      </option>
                    ))}
                  </select>
                ) : null}
                <button
                  type="button"
                  className="primary preview-start"
                  data-testid="preview-start"
                  onClick={() => void toggleDevServer()}
                >
                  <PlayIcon />
                  {ui.startServer}
                </button>
              </div>
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
        onCleanup(
          onAfterImport((importedSession, plan) => {
            if (importedSession.id !== workspace.id) return;
            if (plan.dev) {
              void server.start();
              return;
            }
            if (plan.install) {
              workspace.terminals.requestReveal();
              workspace.terminals.create({ title: "dev", named: true, run: "bun install" });
            }
          }),
        );
        onCleanup(() => void server.dispose());
        return server;
      }}
    >
      {(devServer) => <PreviewPaneBody devServer={devServer} />}
    </Scope>
  );
}
