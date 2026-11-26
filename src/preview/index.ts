import { previewIdentity } from "./identity";
import { createIsolatedPreviewTransport } from "./isolated";
import { buildPreviewDomain, buildPreviewKind } from "./kind";
import { createMountedPreviewTransport } from "./mounted";
import { createInactivePreviewTransport, type PreviewTransport } from "./transport";

/** The preview transport of a workspace, as this build allows (see `previewKind`). */
export function createPreviewTransport(workspace: string): PreviewTransport {
  const kind = buildPreviewKind();
  const domain = buildPreviewDomain();
  if (kind === "mounted") return createMountedPreviewTransport(workspace);
  // The identity is the IDE's own record of the workspace, never something in its files.
  if (kind === "isolated" && domain)
    return createIsolatedPreviewTransport({ domain, identity: () => previewIdentity(workspace) });
  return createInactivePreviewTransport();
}
