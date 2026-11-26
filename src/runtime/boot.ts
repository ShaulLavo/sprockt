// Boots one workspace: a Waffle runtime on its persistent IndexedDB filesystem, with Bun, the
// everyday command-line programs and the shell registered on it. Nothing here knows about UI.
import { installShellCommands } from "bash-web";
import { installBunAdapters, installBunSharedObjects } from "bun-wasm";
import { createRuntime, openIdleWorkspace, type GuestLauncher, type Runtime } from "waffle";
import { installBase } from "waffle-base";
import type { PreviewServer as PreviewBackend } from "waffle/browser/preview";
import { PROJECT_ROOT, storageName } from "../workspace/paths";
import { runtimeAssets } from "./assets";
import { TAB_POLICY } from "./tab-policy";

/**
 * `waiting`: another tab holds this workspace's storage, and this tab waits for it.
 * `moved`: another tab took this workspace over, so this tab's files are no longer live.
 */
export type BootStage = "storage" | "waiting" | "programs" | "ready" | "moved";

export interface BootOptions {
  /** Take the workspace away from the tab that has it. Only after the person said so. */
  readonly takeOver?: boolean;
  /** Aborts when the workspace is closed, also while it still waits for storage. */
  readonly signal?: AbortSignal;
  /** Told about every port a Bun process listens on: the preview transport. */
  readonly ports?: PortListener;
}

/**
 * How much shared memory Bun's process groups may use: 2 GiB per group, 1 GiB per member, 8 MiB
 * stacks. The same values as bun-wasm's `BUN_MEMORY_GROUP_POLICY`, which its package does not
 * export. iPhone needs a smaller, engine-specific policy (bun-wasm `host-memory-policy.ts`).
 */
const MEMORY_GROUPS = { maximumPages: 32768, memberPages: 16384, stackBytes: 8 << 20 } as const;

/** What every shell on this runtime starts with. */
export interface ShellSettings {
  readonly wasmUrl: URL;
  readonly workerUrl: URL;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface WorkspaceRuntime {
  readonly id: string;
  readonly runtime: Runtime;
  readonly shell: ShellSettings;
  /** Stops every process and releases the filesystem. Safe to call more than once. */
  dispose(): Promise<void>;
}

/** Waffle's generic launcher for WASI programs, bound to our bundled program worker. */
export function programLauncher(workerUrl: URL): GuestLauncher {
  return (context, service) =>
    service.launchWorker(context, {
      workerUrl: workerUrl.href,
      request: {
        module: context.module,
        args: context.request.argv,
        env: context.request.env,
        interruptible: context.interruptible,
      },
    });
}

/**
 * What a tab does when another one has the workspace (`TAB_POLICY`, `./tab-policy.ts`). With
 * `"attach"` every tab shares one live filesystem. Otherwise an ordinary open never takes
 * storage from another tab: it waits in line (`"wait"`), and only an open the person confirmed
 * uses `"takeover"`.
 */
function createWorkspaceRuntime(id: string, takeOver: boolean, onStage: (stage: BootStage) => void): Runtime {
  return createRuntime({
    filesystem: {
      mode: "fast",
      name: storageName(id),
      workerURL: runtimeAssets.filesystemWorker,
      whenBusy: TAB_POLICY === "attach" ? "attach" : takeOver ? "takeover" : "wait",
      onStateChange: (state) => {
        if (state.status === "waiting") onStage("waiting");
      },
    },
    memoryGroups: MEMORY_GROUPS,
  });
}

/** Told when a Bun process starts or stops listening on a port, with the way to reach it. */
export interface PortListener {
  listening(port: number, backend: PreviewBackend): void;
  stopped(port: number, backend: PreviewBackend): void;
}

async function installPrograms(runtime: Runtime, ports: PortListener | undefined): Promise<string> {
  installBunSharedObjects(runtime);
  await installBunAdapters(runtime, {
    workerUrl: runtimeAssets.bunWorker,
    notificationWorkerUrl: runtimeAssets.bunNotificationWorker,
    engine: "browser",
    asset: runtimeAssets.bunGuest,
    network: ports,
  });
  const base = await installBase(runtime, { launcher: programLauncher(runtimeAssets.programWorker) });
  await installShellCommands(runtime, {
    wasmUrl: runtimeAssets.shellGuest,
    workerUrl: runtimeAssets.shellWorker,
  });
  return ["/bin"].concat(base.path).join(":");
}

/**
 * On iPhone, Bun's browser engine uses native shared memory as bun-wasm's own host does
 * (`web/src/host-memory-policy.ts`): Safari there reserves each memory's full maximum up front.
 */
function phoneEnv(): Record<string, string> {
  return /\biPhone\b/.test(navigator.userAgent) ? { BUN_WASM_IPHONE_NATIVE_MEMORY: "1" } : {};
}

/**
 * Whether another tab has this workspace open right now. Opening it here would take it away
 * from that tab, so the workbench asks before it does.
 */
export async function workspaceIsOpenElsewhere(id: string): Promise<boolean> {
  // Attaching shares the files with the other tab and takes nothing away from it.
  if (TAB_POLICY === "attach") return false;
  const idle = await openIdleWorkspace({ mode: "fast", name: storageName(id) });
  if (idle === "busy") return true;
  if (idle !== "missing") await idle.close();
  return false;
}

export async function bootWorkspace(
  id: string,
  onStage: (stage: BootStage) => void = () => {},
  options: BootOptions = {},
): Promise<WorkspaceRuntime> {
  // Reported before the runtime exists: the runtime may report `waiting` as soon as it is
  // created, and that must not be overwritten.
  onStage("storage");
  const runtime = createWorkspaceRuntime(id, options.takeOver === true, onStage);
  let disposal: Promise<void> | undefined;
  const dispose = () => (disposal ??= runtime.dispose());
  // Disposing cancels a storage request that is still queued behind another tab.
  options.signal?.addEventListener("abort", () => void dispose().catch(() => {}), { once: true });
  try {
    options.signal?.throwIfAborted();
    runtime.filesystem.onOwnershipLost = () => onStage("moved");
    await runtime.filesystem.mkdirp(PROJECT_ROOT);
    onStage("programs");
    const path = await installPrograms(runtime, options.ports);
    await runtime.filesystem.flush();
    onStage("ready");
    return {
      id,
      runtime,
      shell: {
        wasmUrl: runtimeAssets.shellGuest,
        workerUrl: runtimeAssets.shellWorker,
        cwd: PROJECT_ROOT,
        env: { PATH: path, HOME: "/home/guest", TERM: "xterm-256color", LANG: "C.UTF-8", ...phoneEnv() },
      },
      dispose,
    };
  } catch (error) {
    await dispose().catch(() => {});
    throw error;
  }
}
