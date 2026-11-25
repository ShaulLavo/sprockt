// Boots one workspace: a Waffle runtime on its persistent IndexedDB filesystem, with Bun, the
// everyday command-line programs and the shell registered on it. Nothing here knows about UI.
import { installShellCommands } from "bash-web";
import { installBunAdapters, installBunSharedObjects } from "bun-wasm";
import { createRuntime, type GuestLauncher, type Runtime } from "waffle";
import { installBase } from "waffle-base";
import { PROJECT_ROOT, storageName } from "../workspace/paths";
import { runtimeAssets } from "./assets";

export type BootStage = "storage" | "programs" | "ready";

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
function programLauncher(workerUrl: URL): GuestLauncher {
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
 * What a second tab on the same workspace does. The target is `"attach"`: every tab shares one
 * live filesystem. In Waffle 0.0.148 that mode loses file bytes for programs (an empty `cat`,
 * empty shell redirects; see ARCHITECTURE.md "Known gaps"), so for now the newest tab takes the
 * workspace over and the older tab stops. Switch this back when the fix is pinned.
 */
const TAB_POLICY: "attach" | "takeover" = "takeover";

function createWorkspaceRuntime(id: string): Runtime {
  return createRuntime({
    filesystem: {
      mode: "fast",
      name: storageName(id),
      workerURL: runtimeAssets.filesystemWorker,
      whenBusy: TAB_POLICY,
    },
    memoryGroups: MEMORY_GROUPS,
  });
}

async function installPrograms(runtime: Runtime): Promise<string> {
  installBunSharedObjects(runtime);
  await installBunAdapters(runtime, {
    workerUrl: runtimeAssets.bunWorker,
    notificationWorkerUrl: runtimeAssets.bunNotificationWorker,
    engine: "browser",
    asset: runtimeAssets.bunGuest,
  });
  const base = await installBase(runtime, { launcher: programLauncher(runtimeAssets.programWorker) });
  await installShellCommands(runtime, {
    wasmUrl: runtimeAssets.shellGuest,
    workerUrl: runtimeAssets.shellWorker,
  });
  return ["/bin"].concat(base.path).join(":");
}

export async function bootWorkspace(
  id: string,
  onStage: (stage: BootStage) => void = () => {},
): Promise<WorkspaceRuntime> {
  const runtime = createWorkspaceRuntime(id);
  let disposal: Promise<void> | undefined;
  const dispose = () => (disposal ??= runtime.dispose());
  try {
    onStage("storage");
    await runtime.filesystem.mkdirp(PROJECT_ROOT);
    onStage("programs");
    const path = await installPrograms(runtime);
    await runtime.filesystem.flush();
    onStage("ready");
    return {
      id,
      runtime,
      shell: {
        wasmUrl: runtimeAssets.shellGuest,
        workerUrl: runtimeAssets.shellWorker,
        cwd: PROJECT_ROOT,
        env: { PATH: path, HOME: "/home/guest", TERM: "xterm-256color", LANG: "C.UTF-8" },
      },
      dispose,
    };
  } catch (error) {
    await dispose().catch(() => {});
    throw error;
  }
}
