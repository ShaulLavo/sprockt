import { previewKind } from "./kind";
import { createMountedPreviewTransport } from "./mounted";
import { createInactivePreviewTransport, type PreviewTransport } from "./transport";

/** The preview transport of a workspace, as this build allows (see `previewKind`). */
export function createPreviewTransport(workspace: string): PreviewTransport {
  const kind = previewKind({
    DEV: import.meta.env.DEV,
    VITE_SPROCKT_PREVIEWS: import.meta.env.VITE_SPROCKT_PREVIEWS,
  });
  return kind === "mounted" ? createMountedPreviewTransport(workspace) : createInactivePreviewTransport();
}
