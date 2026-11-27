// One open workspace in this tab: the runtime and the services every pane shares. Panes take
// what they need from here through WorkspaceContext; they never reach into each other.
import { createContext, useContext } from "react";
import { createFileService, type FileService } from "../files/service";
import { WORKSPACE_META_DIR, WORKSPACE_META_PATH } from "../importer/metadata";
import { createPreviewTransport } from "../preview";
import type { PreviewTransport } from "../preview/transport";
import { bootWorkspace, type BootOptions, type BootStage, type WorkspaceRuntime } from "../runtime/boot";
import { createTerminalStore, type TerminalStore } from "../terminal/store";
import { createCommands, createStatusItems, type Commands, type StatusItems } from "../workbench/slots";
import { hydrateWorkspaceName, type HydrateWorkspaceNameDeps } from "./hint";
import { tearDownAll } from "./lifecycle";
import { withServerEnv } from "./shell-env";

const metaDecoder = new TextDecoder();

/** Connects workspace name hydration/adoption to a live session's root metadata and `package.json`. */
export function workspaceNameDeps(
  runtime: WorkspaceRuntime["runtime"],
  files: Pick<FileService, "read" | "writable">,
): HydrateWorkspaceNameDeps {
  return {
    async readMeta() {
      const bytes = await runtime.filesystem.readFile(WORKSPACE_META_PATH);
      return bytes ? metaDecoder.decode(bytes) : undefined;
    },
    async writeMeta(json) {
      if (!files.writable()) return;
      await runtime.filesystem.mkdirp(WORKSPACE_META_DIR);
      await runtime.filesystem.writeFile(WORKSPACE_META_PATH, json);
      await runtime.filesystem.flush();
    },
    readPackageJson: () => files.read("package.json"),
  };
}

export interface WorkspaceSession extends WorkspaceRuntime {
  readonly files: FileService;
  readonly preview: PreviewTransport;
  /** Terminal tabs; `terminals.create({ run })` opens a shell that runs a command. */
  readonly terminals: TerminalStore;
  /** Status bar items other slices fill (`STATUS_SLOT` in workbench/slots.ts). */
  readonly status: StatusItems;
  /** Commands the title bar offers a button for, once registered (`COMMAND`). */
  readonly commands: Commands;
}

const movedError = () => new Error("This workspace is open in another tab, so this tab can no longer save.");

export async function openWorkspace(
  id: string,
  onStage?: (stage: BootStage) => void,
  options?: BootOptions,
): Promise<WorkspaceSession> {
  let moved = false;
  let revoke = (): void => void (moved = true);
  // The transport exists before the runtime it serves, and learns when the storage is open:
  // only a tab that holds the storage open may claim the workspace's preview identity.
  const opened = Promise.withResolvers<void>();
  // A workspace that never opened has no identity to claim; nobody waits for one.
  opened.promise.catch(() => {});
  const preview = createPreviewTransport(id, opened.promise);
  const booted = await bootWorkspace(
    id,
    (stage) => {
      // Another tab took the workspace: this tab's storage is gone, so its writes stop here.
      if (stage === "moved") revoke();
      onStage?.(stage);
    },
    {
      ...options,
      // The transport learns about every port a Bun process listens on.
      ports: {
        listening: (port, backend) => preview.register(port, backend),
        stopped: (port, backend) => preview.unregister(port, backend),
      },
    },
  ).catch(async (error: unknown) => {
    opened.reject(error);
    await preview.dispose();
    throw error;
  });
  opened.resolve();
  const files = createFileService(booted.runtime, booted.id);
  const terminals = createTerminalStore();
  const hydration = new AbortController();
  // Revoking saves first leaves the editor's unsaved text for the new owner; then this tab's
  // shells stop and its runtime goes, so nothing here keeps running against storage it lost.
  // The previews go with them: the preview identity is for a tab that holds the storage.
  revoke = () => {
    hydration.abort();
    files.revoke(movedError());
    void terminals
      .shutdown()
      .then(() => tearDownAll([() => preview.dispose(), () => booted.dispose()]))
      .catch((error: unknown) => console.error("Releasing a workspace taken by another tab failed", error));
  };
  if (moved) {
    revoke();
  } else {
    // Hydrate reactively outside the boot turnstile so a stalled lock in another tab never
    // blocks opening or switching workspaces; disposal aborts any pending lock wait.
    void hydrateWorkspaceName(id, {
      ...workspaceNameDeps(booted.runtime, files),
      signal: hydration.signal,
    }).catch(() => undefined);
  }
  terminals.create();
  return {
    ...booted,
    shell: withServerEnv(booted.shell, preview.serverEnv),
    files,
    preview,
    terminals,
    status: createStatusItems(),
    commands: createCommands(),
    // Every step runs even if an earlier one fails: the runtime must not outlive its session.
    dispose: () => {
      hydration.abort();
      return tearDownAll([() => files.dispose(), () => preview.dispose(), () => booted.dispose()]);
    },
  };
}

export const WorkspaceContext = createContext<WorkspaceSession | undefined>(undefined);

export function useWorkspace(): WorkspaceSession {
  const session = useContext(WorkspaceContext);
  if (!session) throw new Error("useWorkspace needs a WorkspaceContext provider above it");
  return session;
}
