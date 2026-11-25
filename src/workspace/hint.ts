// What this browser remembers about a workspace without opening its storage: the metadata it
// had when it was last created, renamed or listed here. The landing page writes it; the
// workbench reads the name from it, so the title bar shows "vite-react" and not a random id.
import { parseWorkspaceMeta, type WorkspaceMeta } from "../templates/workspace-meta";

export const WORKSPACE_HINT_PREFIX = "sprockt:ws-meta:";

export function readWorkspaceHint(id: string): WorkspaceMeta | undefined {
  try {
    const raw = localStorage.getItem(WORKSPACE_HINT_PREFIX + id);
    return raw ? parseWorkspaceMeta(raw) : undefined;
  } catch {
    return undefined;
  }
}
