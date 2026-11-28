// Lightweight workspace discovery, rename, retry, and deletion for the landing page.
// Cold landing performs only indexedDB.databases() and loads zero Waffle modules;
// warm landing uses only Waffle's fs/ storage modules so waffle/runtime.ts stays unloaded.
import type { WorkspaceSource } from "../workspace/metadata";
import {
  parseWorkspaceMeta,
  WORKSPACE_META_PATH,
  type WorkspaceMeta,
  type WorkspaceState,
} from "../workspace/workspace-meta";
import {
  hasWorkspaceHints,
  mergeStoredWorkspaceMeta,
  readWorkspaceHint,
  removeWorkspaceHint,
  saveWorkspaceHint,
  touchWorkspaceHint,
} from "../workspace/hint";
import { storageName, workspaceIdOf } from "../workspace/paths";

export { hasWorkspaceHints, removeWorkspaceHint, saveWorkspaceHint, touchWorkspaceHint };

// Serialize same-tab storage probes and mutations so a focus/visibility refresh never collides
// with an explicit rename, retry, or delete on the same Waffle maintenance lock.
let storageQueue: Promise<unknown> = Promise.resolve();
let discoverySeq = 0;
let handoffSkipId: string | undefined;
let handoffSkipThroughSeq = 0;
// A database name and a busy lock are weaker evidence than a completed removal or missing result.
const confirmedMissingIds = new Set<string>();

function runSerialized<T>(task: () => Promise<T>): Promise<T> {
  const result = storageQueue.then(task, task);
  storageQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export interface StoredWorkspaceSummary {
  readonly id: string;
  readonly name: string;
  readonly template: string;
  readonly created?: string;
  readonly lastOpened?: string;
  readonly state?: WorkspaceState;
  readonly source?: WorkspaceSource;
  readonly meta?: WorkspaceMeta;
  readonly openInOtherTab: boolean;
}

async function listSprocktWorkspaceIds(): Promise<string[]> {
  if (typeof globalThis.indexedDB?.databases !== "function") return [];
  const databases = await globalThis.indexedDB.databases();
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const { name } of databases) {
    if (!name) continue;
    const id = workspaceIdOf(name);
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

function summaryFromMeta(
  id: string,
  meta: WorkspaceMeta | undefined,
  openInOtherTab: boolean,
): StoredWorkspaceSummary {
  return {
    id,
    name: meta?.name ?? id,
    template: meta?.template ?? "blank",
    created: meta?.created,
    lastOpened: meta?.lastOpened,
    state: meta?.state,
    source: meta?.source,
    meta,
    openInOtherTab,
  };
}

function unverifiedWorkspace(id: string, openInOtherTab: boolean): StoredWorkspaceSummary | undefined {
  if (confirmedMissingIds.has(id)) return undefined;
  return summaryFromMeta(id, readWorkspaceHint(id), openInOtherTab);
}

function confirmWorkspaceMissing(id: string): void {
  confirmedMissingIds.add(id);
  removeWorkspaceHint(id);
}

function compareWorkspaces(a: StoredWorkspaceSummary, b: StoredWorkspaceSummary): number {
  if (a.openInOtherTab !== b.openInOtherTab) return a.openInOtherTab ? -1 : 1;
  const aTime = a.lastOpened ? Date.parse(a.lastOpened) : 0;
  const bTime = b.lastOpened ? Date.parse(b.lastOpened) : 0;
  if (aTime !== bTime) return bTime - aTime;
  return a.id.localeCompare(b.id);
}

export function listStoredWorkspaces(): Promise<StoredWorkspaceSummary[]> {
  const mySeq = ++discoverySeq;
  return runSerialized(async () => {
    const ids = await listSprocktWorkspaceIds();
    if (ids.length === 0) return [];
    const skipId = mySeq <= handoffSkipThroughSeq ? handoffSkipId : undefined;

    const { hasOpenIndexedDbWorkspace, inspectIdleWorkspaceMeta } = await import("./storage-discovery");
    const results = await Promise.all(
      ids.map(async (id): Promise<StoredWorkspaceSummary | undefined> => {
        if (id === skipId) return unverifiedWorkspace(id, false);
        try {
          const name = storageName(id);
          const outcome = await inspectIdleWorkspaceMeta(name, WORKSPACE_META_PATH);
          if (outcome.status === "missing") return undefined;
          if (
            outcome.status === "idle" ||
            (confirmedMissingIds.has(id) && (await hasOpenIndexedDbWorkspace(name)))
          ) {
            confirmedMissingIds.delete(id);
          }
          if (outcome.status === "busy") return unverifiedWorkspace(id, true);
          // Re-read the hint after async disk inspection so a name adopted in another tab during
          // the probe is never overwritten by a stale pre-probe snapshot.
          const hint = readWorkspaceHint(id);
          const meta = outcome.rawMeta ? parseWorkspaceMeta(outcome.rawMeta) : undefined;
          if (meta) {
            const merged = mergeStoredWorkspaceMeta(id, meta, hint);
            saveWorkspaceHint(id, merged);
            return summaryFromMeta(id, merged, false);
          }
          return summaryFromMeta(id, hint, false);
        } catch {
          return unverifiedWorkspace(id, false);
        }
      }),
    );

    const summaries = results.filter((entry): entry is StoredWorkspaceSummary => entry !== undefined);
    summaries.sort(compareWorkspaces);
    return summaries;
  });
}

export function deleteStoredWorkspace(id: string): Promise<"deleted" | "missing" | "busy"> {
  return runSerialized(async () => {
    const { deleteIdleWorkspaceStorage } = await import("./storage-discovery");
    const result = await deleteIdleWorkspaceStorage(storageName(id));
    if (result !== "busy") confirmWorkspaceMissing(id);
    return result;
  });
}

export function renameStoredWorkspace(
  id: string,
  nextName: string,
): Promise<
  | { readonly status: "renamed"; readonly meta: WorkspaceMeta }
  | { readonly status: "busy" | "missing" | "invalid" }
> {
  return runSerialized(async () => {
    const { renameWorkspace } = await import("../templates/seed");
    const result = await renameWorkspace(id, nextName);
    if (result.status === "renamed") {
      confirmedMissingIds.delete(id);
      saveWorkspaceHint(id, result.meta);
    }
    if (result.status === "missing") confirmWorkspaceMissing(id);
    return result;
  });
}

export function retryStoredWorkspace(
  id: string,
  templateId: string,
  name?: string,
): Promise<
  | { readonly status: "seeded"; readonly meta: WorkspaceMeta }
  | { readonly status: "already-ready" | "busy" | "missing" }
> {
  return runSerialized(async () => {
    const { retrySeedWorkspace } = await import("../templates/seed");
    const result = await retrySeedWorkspace(id, templateId, name);
    if (result.status === "seeded") saveWorkspaceHint(id, result.meta);
    if (result.status === "missing") confirmWorkspaceMissing(id);
    if (result.status === "seeded" || result.status === "already-ready") {
      confirmedMissingIds.delete(id);
      handoffSkipId = id;
      handoffSkipThroughSeq = discoverySeq;
    }
    return result;
  });
}
