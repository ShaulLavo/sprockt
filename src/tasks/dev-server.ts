// Runs a project's dev server as a task: detect the command, run it in its own shell on the
// workspace's runtime, and report whether it is up. The task and the terminals are separate
// shells, so stopping the task never touches what the person runs by hand.
import { control, createShell, type Shell } from "bash-web";
import { createSignal, type Accessor } from "solid-js";
import type { Runtime } from "waffle";
import type { FileService } from "../files/service";
import type { PreviewTransport } from "../preview/transport";
import type { ShellSettings } from "../runtime/boot";
import { PROJECT_ROOT } from "../workspace/paths";
import { devCommand, detectWorkspace } from "./detect";

export type DevServerStatus = "stopped" | "starting" | "running";

export interface DevServer {
  readonly status: Accessor<DevServerStatus>;
  /** The end of the task's output, for showing why a start failed. */
  readonly output: Accessor<string>;
  /** Starts the dev server. Resolves false when the project has nothing to start. */
  start(): Promise<boolean>;
  stop(): Promise<void>;
  dispose(): Promise<void>;
}

export interface DevServerHost {
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
  const [status, setStatus] = createSignal<DevServerStatus>("stopped");
  const [output, setOutput] = createSignal("");
  const decoder = new TextDecoder();
  let running: Shell | undefined;

  // The task is "running" once its server listens, and back to "starting" if it stops listening.
  const unsubscribe = host.preview.subscribe((servers) => {
    if (running) setStatus(servers.length > 0 ? "running" : "starting");
  });

  function append(bytes: Uint8Array): void {
    setOutput((text) => (text + decoder.decode(bytes, { stream: true })).slice(-OUTPUT_LIMIT));
  }

  async function command(): Promise<string | undefined> {
    const [project, modules] = await Promise.all([
      detectWorkspace(host.files),
      host.runtime.filesystem.resolvePath(`${PROJECT_ROOT}/node_modules`),
    ]);
    return devCommand(project, modules !== undefined);
  }

  async function run(script: string): Promise<void> {
    const shell = await createShell({
      runtime: host.runtime,
      wasmUrl: host.shell.wasmUrl,
      workerUrl: host.shell.workerUrl,
      cwd: host.shell.cwd,
      env: { ...host.shell.env },
      script,
    });
    running = shell;
    let exited = false;
    void shell.done.finally(() => {
      exited = true;
      shell.terminal.signal();
    });
    await pump(shell, append, () => exited);
    if (running === shell) running = undefined;
    setStatus("stopped");
    await shell.dispose();
  }

  async function stop(): Promise<void> {
    const shell = running;
    if (!shell) return;
    shell.interrupt();
    await shell.done.catch(() => {});
  }

  return {
    status,
    output,
    stop,
    async start() {
      if (status() !== "stopped") return true;
      const script = await command();
      if (!script) return false;
      setOutput("");
      setStatus("starting");
      run(script).catch((error: unknown) => {
        append(new TextEncoder().encode(`\n${error instanceof Error ? error.message : String(error)}\n`));
        setStatus("stopped");
      });
      return true;
    },
    async dispose() {
      unsubscribe();
      await stop();
    },
  };
}
