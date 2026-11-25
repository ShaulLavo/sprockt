import { buildPreviewKind } from "./kind";
import { createMountedPreviewTransport } from "./mounted";
import { createInactivePreviewTransport, type PreviewTransport } from "./transport";

/** The preview transport of a workspace, as this build allows (see `previewKind`). */
export function createPreviewTransport(workspace: string): PreviewTransport {
  return buildPreviewKind() === "mounted"
    ? createMountedPreviewTransport(workspace)
    : createInactivePreviewTransport();
}
