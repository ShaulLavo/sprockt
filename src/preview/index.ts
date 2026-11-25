import { createMountedPreviewTransport } from "./mounted";
import { createInactivePreviewTransport, type PreviewTransport } from "./transport";

/**
 * The preview transport of a workspace. Mounted previews share the IDE's origin, so they exist
 * only in development: under `vite dev`, or in a build made with VITE_SPROCKT_PREVIEWS=mounted
 * (the test build). A public build gets none until isolated preview origins are available.
 */
export function createPreviewTransport(workspace: string): PreviewTransport {
  const mounted = import.meta.env.DEV || import.meta.env.VITE_SPROCKT_PREVIEWS === "mounted";
  return mounted ? createMountedPreviewTransport(workspace) : createInactivePreviewTransport();
}
