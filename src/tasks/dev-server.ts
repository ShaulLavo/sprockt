// Runs a project's dev server as a task: detect the command, run it in a dedicated visible `dev`
// terminal tab on the workspace's runtime (falling back to a standalone shell in headless hosts),
// and report whether it is up.
//
// One tab of a workspace runs the server (tasks/dev-server-line.ts decides which); this file is
// the process and the signals a pane reads.
import { control, createShell, type Shell } from "bash-web";
import { createSignal, type Accessor } from "../lib/reactive";
import type { Runtime } from "waffle";
import type { FileService } from "../files/service";
import type { PreviewTransport } from "../preview/transport";
import type { ShellSettings } from "../runtime/boot";
import type { TerminalStore } from "../terminal/store";
import { createDevServerCoordinator, type CoordinatorOptions } from "../workspace/coordinator";
import { PROJECT_ROOT } from "../workspace/paths";
import { createDevServerLine, type DevServerStatus, type ServerProcess } from "./dev-server-line";
import {
  detectWorkspaceTargets,
  devStart,
  devStartForTarget,
  shellWord,
  type DevStart,
  type WorkspaceTarget,
} from "./detect";
import { latestOnly } from "./latest";
import { affectsProject, isSourceEdit, restartingProcess, type Run } from "./restarting";

export type { DevServerStatus } from "./dev-server-line";
export type { WorkspaceTarget } from "./detect";

export interface DevServer {
  /** The workspace's dev server, in whichever tab it runs. */
  readonly status: Accessor<DevServerStatus>;
  /** Whether this tab runs it. Another tab's server is stopped in that tab. */
  readonly owned: Accessor<boolean>;
  /** Ports of a server another tab runs; the workspace's preview address reaches them. */
  readonly remotePorts: Accessor<readonly number[]>;
  /** The end of the task's output in this tab. It stays until the next start. */
  readonly output: Accessor<string>;
  /**
   * Whether the last run in this tab ended without being stopped: the command failed or
   * finished. The pane then keeps `output` on screen, which says why.
   */
  readonly ended: Accessor<boolean>;
  /**
   * Whether an edit was not picked up because the server had been restarted too often in a
   * short time (tasks/restarting.ts). False again once a restart goes through or the server stops.
   */
  readonly restartHeld: Accessor<boolean>;
  /** Whether the project has something to start: a dev script or a server entry file. */
  readonly startable: Accessor<boolean>;
  /** Detected runnable workspace apps and scripts (monorepo packages plus root scripts). */
  readonly targets: Accessor<readonly WorkspaceTarget[]>;
  /** Target id matching the detected default Start/import command. */
  readonly defaultTargetId: Accessor<string | undefined>;
  /** Explicitly chosen target id, or `undefined` to use the detected default. */
  readonly selectedTargetId: Accessor<string | undefined>;
  /** Target id currently running in this tab, kept stable until that run stops or ends. */
  readonly runningTargetId: Accessor<string | undefined>;
  /** Target id currently running in another tab, when following a remote owner. */
  readonly remoteTargetId: Accessor<string | undefined>;
  /** Chooses which detected workspace app or script the next start will run. */
  selectTarget(id: string | undefined): void;
  /**
   * Asks for the dev server. Calls made while one is under way share it. Resolves false when
   * the project has nothing to start.
   */
  start(): Promise<boolean>;
  /** Stops the server this tab runs. */
  stop(): void;
  dispose(): Promise<void>;
}

export interface DevServerHost {
  /** The workspace id, which names the line the tabs of this workspace stand in. */
  readonly id: string;
  readonly runtime: Runtime;
  readonly shell: ShellSettings;
  readonly files: FileService;
  readonly preview: PreviewTransport;
  /** When present, dev server runs appear inside a visible `dev` terminal tab. */
  readonly terminals?: TerminalStore;
  /** Test seam for injecting fake Web Locks / BroadcastChannel without a browser. */
  readonly coordinator?: Pick<CoordinatorOptions, "tabId" | "locks" | "openChannel">;
}

/** How much of the task's output is kept. */
const OUTPUT_LIMIT = 16_384;

interface ResolvedStart extends DevStart {
  /** Selection generation captured when a takeover lookup began; commits only if unchanged. */
  readonly inheritedAtSelection?: number;
}

async function pump(
  shell: Shell,
  onOutput: (bytes: Uint8Array) => void,
  finished: () => boolean,
): Promise<void> {
  const { terminal } = shell;
  for (;;) {
    const sequence = Atomics.load(terminal.state, control.wake);
    const bytes = terminal.drain();
    if (bytes.length > 0) onOutput(bytes);
    else if (finished()) return;
    // Output arrives in order; each wait is for the next piece of it.
    // oxlint-disable-next-line no-await-in-loop
    else await Atomics.waitAsync(terminal.state, control.wake, sequence).value;
  }
}

export function createDevServer(host: DevServerHost): DevServer {
  const [output, setOutput] = createSignal("");
  const [ended, setEnded] = createSignal(false);
  const [restartHeld, setRestartHeld] = createSignal(false);
  const [targets, setTargets] = createSignal<readonly WorkspaceTarget[]>([]);
  const [defaultTargetId, setDefaultTargetId] = createSignal<string | undefined>(undefined);
  const [selectedTargetId, setSelectedTargetId] = createSignal<string | undefined>(undefined);
  const [runningTargetId, setRunningTargetId] = createSignal<string | undefined>(undefined);
  const decoder = new TextDecoder();
  let devTabId: string | undefined;
  let runToken = 0;
  let selectionGeneration = 0;

  function append(bytes: Uint8Array): void {
    setOutput((text) => (text + decoder.decode(bytes, { stream: true })).slice(-OUTPUT_LIMIT));
  }

  function report(error: unknown): void {
    append(new TextEncoder().encode(`\n${error instanceof Error ? error.message : String(error)}\n`));
  }

  async function command(preferredTargetId?: string): Promise<ResolvedStart | undefined> {
    const selectionAtStart = selectionGeneration;
    const [detected, modules] = await Promise.all([
      detectWorkspaceTargets(host.files),
      host.runtime.filesystem.resolvePath(`${PROJECT_ROOT}/node_modules`),
    ]);
    setTargets(detected.targets);
    setDefaultTargetId(detected.defaultTargetId);
    const chosenId = preferredTargetId ?? selectedTargetId();
    const chosen = chosenId ? detected.targets.find((target) => target.id === chosenId) : undefined;
    const hasNodeModules = modules !== undefined;
    if (chosen) {
      const start = devStartForTarget(detected.detection, chosen, hasNodeModules);
      return preferredTargetId ? { ...start, inheritedAtSelection: selectionAtStart } : start;
    }
    const fallback = devStart(detected.detection, hasNodeModules);
    if (!fallback) return undefined;
    return detected.defaultTargetId ? { ...fallback, targetId: detected.defaultTargetId } : fallback;
  }

  function ensureDevTerminal(terminals: TerminalStore): string {
    terminals.requestReveal();
    const existing = devTabId && terminals.tabs().tabs.some((tab) => tab.id === devTabId);
    if (existing && devTabId) {
      const tabState = terminals.stateOf(devTabId);
      const handle = terminals.handle(devTabId);
      const reusable = (tabState === "ready" || tabState === "starting") && !handle?.isRunning();
      if (reusable) {
        terminals.select(devTabId);
        return devTabId;
      }
    }
    const created = terminals.create({ title: "dev", named: true });
    devTabId = created || undefined;
    return created;
  }

  /** Anchors every reused-terminal command to `host.shell.cwd` so an interactive `cd` cannot break Start. */
  function anchoredCommand(script: string): string {
    return `(cd ${shellWord(host.shell.cwd)} && ${script})`;
  }

  /** One run of `script` in the visible `dev` terminal tab, streaming output live and honoring Ctrl-C. */
  async function openTerminalRun(
    terminals: TerminalStore,
    script: string,
    signal: AbortSignal,
  ): Promise<Run> {
    const tabId = ensureDevTerminal(terminals);
    if (!tabId) return { done: Promise.resolve(), interrupt() {} };
    const waited = await terminals.waitForHandle(tabId, signal);
    if (!waited.ok) {
      if (waited.reason === "failed") {
        throw new Error(waited.message ?? "Dev terminal failed to start.");
      }
      return { done: Promise.resolve(), interrupt() {} };
    }
    const { handle } = waited;

    let interrupted = false;
    let settled = false;
    const unsubscribeOutput = terminals.subscribeOutput(tabId, append);
    const done = handle
      .submit(anchoredCommand(script))
      .catch((error: unknown) => {
        if (!interrupted && !signal.aborted) report(error);
      })
      .finally(() => {
        settled = true;
        unsubscribeOutput();
      });
    return {
      done,
      interrupt() {
        if (settled) return;
        interrupted = true;
        handle.interrupt();
      },
    };
  }

  /** Headless fallback when no `TerminalStore` is attached. */
  async function openHeadlessRun(script: string): Promise<Run> {
    const shell = await createShell({
      runtime: host.runtime,
      wasmUrl: host.shell.wasmUrl,
      workerUrl: host.shell.workerUrl,
      cwd: host.shell.cwd,
      env: { ...host.shell.env },
      script,
    });
    let over = false;
    const wake = () => {
      over = true;
      shell.terminal.signal();
    };
    shell.done.then(wake, wake);
    const done = pump(shell, append, () => over)
      .then(() => shell.dispose())
      .catch(report);
    return {
      done,
      interrupt() {
        if (!over) shell.interrupt();
      },
    };
  }

  /** Starts the server. A command that does not reload itself runs again when the source changes. */
  async function spawn(start: ResolvedStart, signal: AbortSignal): Promise<ServerProcess> {
    const token = ++runToken;
    if (
      start.inheritedAtSelection !== undefined &&
      start.targetId &&
      !signal.aborted &&
      selectionGeneration === start.inheritedAtSelection
    ) {
      setSelectedTargetId(start.targetId);
    }
    setRunningTargetId(start.targetId);
    setOutput("");
    setEnded(false);
    setRestartHeld(false);
    let stopped = false;
    const clearRunning = () => {
      if (runToken === token) setRunningTargetId(undefined);
    };
    const process = await restartingProcess({
      script: start.script,
      rerun: start.rerun,
      signal,
      open: (script) =>
        host.terminals ? openTerminalRun(host.terminals, script, signal) : openHeadlessRun(script),
      // Only what a person changed through the file service: what the server writes itself, or
      // anything else a program writes, must never restart it.
      onSourceEdit: (listener) =>
        host.files.subscribeEdits((paths) => {
          if (isSourceEdit(paths)) listener();
        }),
      onRestart: () => setOutput(""),
      onHeld: setRestartHeld,
    }).catch((error: unknown) => {
      // No shell, so no server: what went wrong is the output, and it stays on screen.
      clearRunning();
      setEnded(true);
      throw error;
    });
    return {
      command: process.command,
      targetId: start.targetId,
      // It ended without being asked to: its last output says why, and the pane keeps it.
      exited: process.exited.catch(report).finally(() => {
        clearRunning();
        setRestartHeld(false);
        setEnded(!stopped && !signal.aborted);
      }),
      stop() {
        stopped = true;
        process.stop();
      },
    };
  }

  const line = createDevServerLine({
    coordinator: createDevServerCoordinator({
      workspaceId: host.id,
      onError: report,
      ...host.coordinator,
    }),
    ports: {
      current: () => host.preview.servers().map((server) => server.port),
      subscribe: (listener) => host.preview.subscribe(listener),
    },
    command,
    spawn,
  });
  const [state, setState] = createSignal(line.state());
  line.subscribe(setState);

  // Whether the project has something to start, kept current as its files change.
  const [startable, setStartable] = createSignal(false);
  const looker = latestOnly(async () => setStartable((await command()) !== undefined));
  const unwatch = host.files.subscribe((change) => {
    if (affectsProject(change)) looker.run();
  });
  looker.run();

  return {
    status: () => state().status,
    owned: () => state().owned,
    remotePorts: () => state().remotePorts,
    output,
    ended,
    restartHeld,
    startable,
    targets,
    defaultTargetId,
    selectedTargetId,
    runningTargetId,
    remoteTargetId: () => state().remoteTargetId,
    selectTarget(id) {
      selectionGeneration++;
      setSelectedTargetId(id);
    },
    start: () => line.start(),
    stop() {
      runToken++;
      setRunningTargetId(undefined);
      line.stop();
    },
    dispose() {
      runToken++;
      setRunningTargetId(undefined);
      unwatch();
      return line.dispose();
    },
  };
}
