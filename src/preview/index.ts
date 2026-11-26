import { previewIdentity } from "./identity";
import { createIsolatedPreviewTransport } from "./isolated";
import { buildPreviewDomain, buildPreviewKind } from "./kind";
import { createMountedPreviewTransport } from "./mounted";
import { createInactivePreviewTransport, type PreviewTransport } from "./transport";

/**
 * The preview transport of a workspace, as this build allows (see `previewKind`).
 *
 * `opened` resolves once this tab has the workspace's storage open. The preview identity is
 * claimed only after that: a tab that holds the storage open cannot meet a deletion of it,
 * which is the one place an identity is forgotten (workspace/storage-lifecycle.ts).
 */
export function createPreviewTransport(workspace: string, opened: Promise<unknown>): PreviewTransport {
  const kind = buildPreviewKind();
  const domain = buildPreviewDomain();
  if (kind === "mounted") return createMountedPreviewTransport(workspace);
  if (kind !== "isolated" || !domain) return createInactivePreviewTransport();
  // The identity is the IDE's own record of the workspace, never something in its files.
  const identity = async (): Promise<string> => {
    await opened;
    return previewIdentity(workspace);
  };
  return createIsolatedPreviewTransport({ domain, identity });
}
