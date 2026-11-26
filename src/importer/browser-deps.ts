// The real dependencies of `createWorkspaceWithFiles` in the browser, and the hand-off to the
// workbench once the new workspace is written.
import { storedWorkspaces } from "waffle";
import { isWorkspaceId } from "../workspace/paths";
import { openWorkspace } from "../workspace/session";
import { replaceRoute } from "./navigation";
import type { NewWorkspaceDeps } from "./new-workspace";

export const browserWorkspaceDeps: NewWorkspaceDeps = {
  open: (id) => openWorkspace(id),
  // The one deletion every workspace goes through (workspace/storage-lifecycle.ts): the IDE's
  // own records of the storage go in the same step, and stay when the storage is busy.
  remove: async (name) => {
    const { deleteIdleWorkspaceStorage } = await import("../landing/storage-discovery");
    return deleteIdleWorkspaceStorage(name);
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
