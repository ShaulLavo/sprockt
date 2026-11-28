// Workspace seeding (delegated to shared `createWorkspaceWithFiles`) and atomic non-stealing rename.
// Uses the shared exclusive browser writer (`whenBusy: "ifAvailable"`), so another tab's ownership
// is never stolen and `waffle/runtime.ts` stays unloaded on `/`.
import { browserWorkspaceDeps, openExistingBrowserWriter } from "../importer/browser-deps";
import {
  createWorkspaceWithFiles,
  NotIncompleteError,
  RetrySourceMismatchError,
  WorkspaceBusyError,
  WorkspaceIdTakenError,
  WorkspaceMissingError,
  type NewWorkspaceDeps,
  type WorkspaceWriter,
} from "../importer/new-workspace";
import { BLANK_TEMPLATE, findTemplate, type TemplateId } from "./catalog";
import {
  createWorkspaceMeta,
  normalizeWorkspaceName,
  updateWorkspaceMetaName,
  WORKSPACE_META_DIR,
  WORKSPACE_META_PATH,
  type WorkspaceMeta,
} from "./workspace-meta";

export {
  NotIncompleteError,
  RetrySourceMismatchError,
  WorkspaceBusyError,
  WorkspaceIdTakenError,
  WorkspaceMissingError,
};

const decoder = new TextDecoder();

export interface OpenRenameOptions {
  readonly requireExisting: boolean;
  readonly signal?: AbortSignal;
}

export interface RenameWorkspaceDeps {
  readonly open: (id: string, options: OpenRenameOptions) => Promise<WorkspaceWriter | "busy" | "missing">;
}

const DEFAULT_RENAME_DEPS: RenameWorkspaceDeps = {
  open: (id, options) => openExistingBrowserWriter(id, options.signal),
};

export interface SeedWorkspaceOptions {
  readonly customName?: string;
  readonly signal?: AbortSignal;
}

export interface SeedWorkspaceResult {
  readonly id: string;
  readonly meta: WorkspaceMeta;
}

/**
 * Seeds a starter template into a brand-new workspace using the shared `createWorkspaceWithFiles`
 * helper (atomic create-if-absent claim, `state: "importing"` marker written first and cleared
 * after final flush, never deletes a workspace on failure or cancellation).
 */
export async function seedWorkspace(
  templateId: TemplateId,
  options: SeedWorkspaceOptions = {},
  deps: NewWorkspaceDeps = browserWorkspaceDeps,
): Promise<SeedWorkspaceResult> {
  const template = findTemplate(templateId) ?? BLANK_TEMPLATE;
  const meta = createWorkspaceMeta({
    name: options.customName ?? template.defaultName,
    template: template.id,
    defaultName: !options.customName && template.id === BLANK_TEMPLATE.id,
  });
  const id = await createWorkspaceWithFiles(template.files, meta, deps, { signal: options.signal });
  return { id, meta };
}

export type RetrySeedResult =
  | { readonly status: "seeded"; readonly meta: WorkspaceMeta }
  | { readonly status: "already-ready" | "busy" | "missing" };

/**
 * Finishes seeding an unfinished template workspace in place using `createWorkspaceWithFiles(..., { into: id })`.
 * Never steals another tab's lock, verifies the stored template matches, and refuses a finished workspace.
 */
export async function retrySeedWorkspace(
  id: string,
  templateId: string,
  customName?: string,
  deps: NewWorkspaceDeps = browserWorkspaceDeps,
): Promise<RetrySeedResult> {
  const template = findTemplate(templateId);
  if (!template) throw new RetrySourceMismatchError(id);
  const meta = createWorkspaceMeta({
    name: customName ?? template.defaultName,
    template: template.id,
    defaultName: !customName && template.id === BLANK_TEMPLATE.id,
  });
  try {
    await createWorkspaceWithFiles(template.files, meta, deps, { into: id });
    return { status: "seeded", meta };
  } catch (error) {
    if (error instanceof WorkspaceBusyError) return { status: "busy" };
    if (error instanceof WorkspaceMissingError) return { status: "missing" };
    if (error instanceof NotIncompleteError) return { status: "already-ready" };
    throw error;
  }
}

export type RenameResult =
  | { readonly status: "renamed"; readonly meta: WorkspaceMeta }
  | { readonly status: "busy" | "missing" | "invalid" };

/**
 * Renames an existing idle workspace under a single non-stealing exclusive lock.
 * Never revokes another tab's ownership and never recreates a deleted workspace.
 */
export async function renameWorkspace(
  id: string,
  nextName: string,
  deps: RenameWorkspaceDeps = DEFAULT_RENAME_DEPS,
): Promise<RenameResult> {
  const normalized = normalizeWorkspaceName(nextName);
  if (!normalized) return { status: "invalid" };

  const opened = await deps.open(id, { requireExisting: true });
  if (opened === "busy" || opened === "missing") return { status: opened };

  try {
    const rawBytes = await opened.runtime.filesystem.readFile(WORKSPACE_META_PATH);
    const rawMeta = rawBytes ? decoder.decode(rawBytes) : undefined;
    const { json, meta } = updateWorkspaceMetaName(rawMeta, normalized);
    await opened.runtime.filesystem.mkdirp(WORKSPACE_META_DIR);
    await opened.runtime.filesystem.writeFile(WORKSPACE_META_PATH, json);
    await opened.runtime.filesystem.flush();
    await opened.dispose();
    return { status: "renamed", meta };
  } catch (error) {
    await opened.dispose().catch(() => undefined);
    throw error;
  }
}
