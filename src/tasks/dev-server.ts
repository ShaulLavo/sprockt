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
  /** The end of the task's output in this tab, for showing why a start failed. */
  readonly output: Accessor<string>;
  /** Asks for the dev server. Resolves false when the project has nothing to start. */
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

  /** Runs `script` in a shell of its own and copies its output until it ends. */
  async function spawn(script: string): Promise<ServerProcess> {
    const shell = await createShell({
      runtime: host.runtime,
      wasmUrl: host.shell.wasmUrl,
      workerUrl: host.shell.workerUrl,
      cwd: host.shell.cwd,
      env: { ...host.shell.env },
      script,
    });
    let ended = false;
    const wake = () => {
      ended = true;
      shell.terminal.signal();
    };
    shell.done.then(wake, wake);
    const exited = pump(shell, append, () => ended)
      .then(() => shell.dispose())
      .catch(report);
    return {
      command: script,
      exited,
      stop() {
        if (!ended) shell.interrupt();
      },
    };
  }

  const line = createDevServerLine({
    coordinator: createDevServerCoordinator({ workspaceId: host.id, onError: report }),
    ports: {
      current: () => host.preview.servers().map((server) => server.port),
      subscribe: (listener) => host.preview.subscribe(listener),
    },
    // Detected again here: a tab that takes the server over was never asked to start it.
    async launch() {
      const script = await command();
      if (!script) return undefined;
      setOutput("");
      return spawn(script);
    },
  });
  const [state, setState] = createSignal(line.state());
  line.subscribe(setState);

  return {
    status: () => state().status,
    owned: () => state().owned,
    remotePorts: () => state().remotePorts,
    output,
    stop: () => line.stop(),
    async start() {
      if (state().status !== "stopped") return true;
      if (!(await command())) return false;
      line.start();
      return true;
    },
    dispose: () => line.dispose(),
  };
}
