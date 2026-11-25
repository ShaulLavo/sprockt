// Runs a project's dev server as a task: detect the command, run it in its own shell on the
// workspace's runtime, and report whether it is up. The task and the terminals are separate
// shells, so stopping the task never touches what the person runs by hand.
//
// One tab of a workspace runs the server (tasks/dev-server-line.ts decides which); this file is
// the process and the signals a pane reads.
import { control, createShell, type Shell } from "bash-web";
import { createSignal, type Accessor } from "solid-js";
import type { Runtime } from "waffle";
import type { FileService } from "../files/service";
import type { PreviewTransport } from "../preview/transport";
import type { ShellSettings } from "../runtime/boot";
import { createDevServerCoordinator } from "../workspace/coordinator";
import { PROJECT_ROOT } from "../workspace/paths";
import { createDevServerLine, type DevServerStatus, type ServerProcess } from "./dev-server-line";
import { devCommand, detectWorkspace } from "./detect";

export type { DevServerStatus } from "./dev-server-line";

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
}

/** How much of the task's output is kept. */
const OUTPUT_LIMIT = 16_384;

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
  const decoder = new TextDecoder();

  function append(bytes: Uint8Array): void {
    setOutput((text) => (text + decoder.decode(bytes, { stream: true })).slice(-OUTPUT_LIMIT));
  }

  function report(error: unknown): void {
    append(new TextEncoder().encode(`\n${error instanceof Error ? error.message : String(error)}\n`));
  }

  async function command(): Promise<string | undefined> {
    const [project, modules] = await Promise.all([
      detectWorkspace(host.files),
      host.runtime.filesystem.resolvePath(`${PROJECT_ROOT}/node_modules`),
    ]);
    return devCommand(project, modules !== undefined);
  }

  function openShell(script: string): Promise<Shell> {
    return createShell({
      runtime: host.runtime,
      wasmUrl: host.shell.wasmUrl,
      workerUrl: host.shell.workerUrl,
      cwd: host.shell.cwd,
      env: { ...host.shell.env },
      script,
    }).catch((error: unknown) => {
      // No shell, so no server: what went wrong is the output, and it stays on screen.
      setEnded(true);
      throw error;
    });
  }

  /** Runs `script` in a shell of its own and copies its output until it ends. */
  async function spawn(script: string): Promise<ServerProcess> {
    setOutput("");
    setEnded(false);
    const shell = await openShell(script);
    let over = false;
    let stopped = false;
    const wake = () => {
      over = true;
      shell.terminal.signal();
    };
    shell.done.then(wake, wake);
    const exited = pump(shell, append, () => over)
      .then(() => shell.dispose())
      .catch(report)
      // It ended without being asked to: its last output says why, and the pane keeps it.
      .finally(() => setEnded(!stopped));
    return {
      command: script,
      exited,
      stop() {
        stopped = true;
        if (!over) shell.interrupt();
      },
    };
  }

  const line = createDevServerLine({
    coordinator: createDevServerCoordinator({ workspaceId: host.id, onError: report }),
    ports: {
      current: () => host.preview.servers().map((server) => server.port),
      subscribe: (listener) => host.preview.subscribe(listener),
    },
    command,
    spawn,
  });
  const [state, setState] = createSignal(line.state());
  line.subscribe(setState);

  return {
    status: () => state().status,
    owned: () => state().owned,
    remotePorts: () => state().remotePorts,
    output,
    ended,
    start: () => line.start(),
    stop: () => line.stop(),
    dispose: () => line.dispose(),
  };
}
