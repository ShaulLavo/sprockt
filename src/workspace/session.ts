// One open workspace in this tab: the runtime and the services every pane shares. Panes take
// what they need from here through WorkspaceContext; they never reach into each other.
import { createContext, useContext } from "solid-js";
import { createFileService, type FileService } from "../files/service";
import { createInactivePreviewTransport, type PreviewTransport } from "../preview/transport";
import { bootWorkspace, type BootStage, type WorkspaceRuntime } from "../runtime/boot";

export interface WorkspaceSession extends WorkspaceRuntime {
  readonly files: FileService;
  readonly preview: PreviewTransport;
}

export async function openWorkspace(
  id: string,
  onStage?: (stage: BootStage) => void,
): Promise<WorkspaceSession> {
  const booted = await bootWorkspace(id, onStage);
  const preview = createInactivePreviewTransport();
  const files = createFileService(booted.runtime);
  return {
    ...booted,
    files,
    preview,
    async dispose() {
      files.dispose();
      await preview.dispose();
      await booted.dispose();
    },
  };
}

export const WorkspaceContext = createContext<WorkspaceSession>();

export function useWorkspace(): WorkspaceSession {
  const session = useContext(WorkspaceContext);
  if (!session) throw new Error("useWorkspace needs a WorkspaceContext provider above it");
  return session;
}
