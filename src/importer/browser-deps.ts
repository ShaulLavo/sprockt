// The real dependencies of `createWorkspaceWithFiles` in the browser, and the hand-off to the
// workbench once the new workspace is written.
import { deleteWorkspace, storedWorkspaces } from "waffle";
import { isWorkspaceId } from "../workspace/paths";
import { openWorkspace } from "../workspace/session";
import { replaceRoute } from "./navigation";
import type { NewWorkspaceDeps } from "./new-workspace";

export const browserWorkspaceDeps: NewWorkspaceDeps = {
  open: (id) => openWorkspace(id),
  // The preview identity goes with the storage: a workspace made again under this name must
  // not get this one's preview origins.
  remove: async (name) => {
    const result = await deleteWorkspace({ mode: "fast", name });
    const { forgetPreviewIdentity } = await import("../preview/identity-store");
    await forgetPreviewIdentity(name);
    return result;
  },
  exists: async (name) => (await storedWorkspaces("fast")).includes(name),
};

/**
 * Opens the finished workspace, unless the visitor left while it was being written. The
 * workspace is complete either way and stays; it is listed on the landing page.
 */
export function openUnlessCancelled(id: string, signal: AbortSignal): void {
  if (!signal.aborted) replaceRoute({ kind: "workspace", id });
}

/** `?into=<id>` on an import URL: Retry of an unfinished import rewrites that workspace. */
export function retryTarget(search: string): string | undefined {
  const into = new URLSearchParams(search).get("into");
  return into && isWorkspaceId(into) ? into : undefined;
}
