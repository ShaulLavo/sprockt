import { createIsolatedPreviewTransport } from "./isolated";
import { buildPreviewDomain, buildPreviewKind } from "./kind";
import { createMountedPreviewTransport } from "./mounted";
import { createInactivePreviewTransport, type PreviewTransport } from "./transport";

/**
 * The preview transport of a workspace, as this build allows (see `previewKind`). `identity`
 * reads the workspace's preview identity (identity.ts); only isolated previews ask for it.
 */
export function createPreviewTransport(workspace: string, identity: () => Promise<string>): PreviewTransport {
  const kind = buildPreviewKind();
  const domain = buildPreviewDomain();
  if (kind === "mounted") return createMountedPreviewTransport(workspace);
  if (kind === "isolated" && domain) return createIsolatedPreviewTransport({ domain, identity });
  return createInactivePreviewTransport();
}
