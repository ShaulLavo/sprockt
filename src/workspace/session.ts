// One open workspace in this tab: the runtime and the services every pane shares. Panes take
// what they need from here through WorkspaceContext; they never reach into each other.
import { createContext, useContext } from "solid-js";
import { createFileService, type FileService } from "../files/service";
import { createInactivePreviewTransport, type PreviewTransport } from "../preview/transport";
import { bootWorkspace, type BootOptions, type BootStage, type WorkspaceRuntime } from "../runtime/boot";
import { tearDownAll } from "./lifecycle";

export interface WorkspaceSession extends WorkspaceRuntime {
  readonly files: FileService;
  readonly preview: PreviewTransport;
}

const movedError = () => new Error("This workspace is open in another tab, so this tab can no longer save.");

export async function openWorkspace(
  id: string,
  onStage?: (stage: BootStage) => void,
  options?: BootOptions,
): Promise<WorkspaceSession> {
  let moved = false;
  let revoke = (): void => void (moved = true);
  const booted = await bootWorkspace(
    id,
    (stage) => {
      // Another tab took the workspace: this tab's storage is gone, so its writes stop here.
      if (stage === "moved") revoke();
      onStage?.(stage);
    },
    options,
  );
  const preview = createInactivePreviewTransport();
  const files = createFileService(booted.runtime);
  revoke = () => files.revoke(movedError());
  if (moved) revoke();
  return {
    ...booted,
    files,
    preview,
    // Every step runs even if an earlier one fails: the runtime must not outlive its session.
    dispose: () => tearDownAll([() => files.dispose(), () => preview.dispose(), () => booted.dispose()]),
  };
}

export const WorkspaceContext = createContext<WorkspaceSession>();

export function useWorkspace(): WorkspaceSession {
  const session = useContext(WorkspaceContext);
  if (!session) throw new Error("useWorkspace needs a WorkspaceContext provider above it");
  return session;
}
