// Finding and acting on workspaces whose writing was cut off (marker `state: "importing"` in
// /.sprockt/workspace.json, see new-workspace.ts). Shared with the landing page and with
// template seeding: anything that writes a new workspace through `createWorkspaceWithFiles`
// gets the marker, and the landing list shows the result through `IncompleteImport`.
import { routePath } from "../routing/routes";
import { storageName } from "../workspace/paths";
import { INCOMPLETE, parseMeta, WORKSPACE_META_PATH, type WorkspaceMeta } from "../workspace/metadata";

/** What `readIncomplete` needs from Waffle's idle workspace API (`openIdleWorkspace`). */
export type OpenIdle = (selection: {
  readonly mode: "fast";
  readonly name: string;
}) => Promise<
  { readFile(path: string): Promise<Uint8Array | undefined>; close(): Promise<void> } | "busy" | "missing"
>;

const decoder = new TextDecoder();

/**
 * The metadata of workspace `id` when its marker is still set, else `undefined`. Reads the
 * stored workspace without booting it; a workspace open in another tab reads as not incomplete.
 */
export async function readIncomplete(id: string, openIdle: OpenIdle): Promise<WorkspaceMeta | undefined> {
  const idle = await openIdle({ mode: "fast", name: storageName(id) });
  if (idle === "busy" || idle === "missing") return undefined;
  try {
    const bytes = await idle.readFile(WORKSPACE_META_PATH);
    const meta = parseMeta(bytes && decoder.decode(bytes));
    return meta?.state === INCOMPLETE ? meta : undefined;
  } finally {
    await idle.close();
  }
}

/**
 * Where Retry goes: the import of the recorded source, rewriting this same workspace. Share
 * links do not record their fragment, so an unfinished share can only be deleted.
 */
export function retryPath(id: string, meta: WorkspaceMeta): string | undefined {
  const source = meta.source;
  if (source?.kind !== "github") return undefined;
  const path = routePath({
    kind: "github",
    owner: source.owner,
    repo: source.repo,
    ...(source.ref ? { branch: source.ref } : {}),
    ...(source.ref && source.subdir ? { subdir: source.subdir } : {}),
  });
  return `${path}?into=${id}`;
}
