// Lightweight workspace discovery and deletion for the landing page.
// Dynamically loads Waffle storage APIs after first paint so the entry bundle stays minimal.
import {
  parseWorkspaceMeta,
  serializeWorkspaceMeta,
  WORKSPACE_META_PATH,
  type WorkspaceMeta,
} from "../templates/workspace-meta";
import { storageName, workspaceIdOf } from "../workspace/paths";

const HINT_PREFIX = "sprockt:ws-meta:";
const decoder = new TextDecoder();

// Serialize same-tab storage probes and mutations so a focus/visibility refresh never collides
// with an explicit rename or delete on the same Waffle maintenance lock.
let storageQueue: Promise<unknown> = Promise.resolve();

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
  readonly openInOtherTab: boolean;
}

export function saveWorkspaceHint(id: string, meta: WorkspaceMeta): void {
  try {
    localStorage.setItem(HINT_PREFIX + id, serializeWorkspaceMeta(meta));
  } catch {
    // Ignore storage quota or private-mode refusals.
  }
}

function readWorkspaceHint(id: string): WorkspaceMeta | undefined {
  try {
    const raw = localStorage.getItem(HINT_PREFIX + id);
    return raw ? parseWorkspaceMeta(raw) : undefined;
  } catch {
    return undefined;
  }
}

export function removeWorkspaceHint(id: string): void {
  try {
    localStorage.removeItem(HINT_PREFIX + id);
  } catch {
    // Ignore private-mode refusals.
  }
}

export function touchWorkspaceHint(id: string): void {
  const existing = readWorkspaceHint(id);
  if (!existing) return;
  saveWorkspaceHint(id, { ...existing, lastOpened: new Date().toISOString() });
}

async function inspectWorkspace(
  id: string,
  openIdle: (selection: { readonly mode: "fast"; readonly name: string }) => Promise<
    | {
        readFile(path: string): Promise<Uint8Array | undefined>;
        close(): Promise<void>;
      }
    | "busy"
    | "missing"
  >,
): Promise<StoredWorkspaceSummary | undefined> {
  const name = storageName(id);
  const idle = await openIdle({ mode: "fast", name });
  if (idle === "missing") return undefined;

  if (idle === "busy") {
    const hint = readWorkspaceHint(id);
    return {
      id,
      name: hint?.name ?? id,
      template: hint?.template ?? "blank",
      created: hint?.created,
      lastOpened: hint?.lastOpened,
      openInOtherTab: true,
    };
  }

  let meta: WorkspaceMeta | undefined;
  try {
    const bytes = await idle.readFile(WORKSPACE_META_PATH);
    if (bytes) meta = parseWorkspaceMeta(decoder.decode(bytes));
  } finally {
    await idle.close();
  }

  if (meta) saveWorkspaceHint(id, meta);
  const hint = meta ?? readWorkspaceHint(id);
  return {
    id,
    name: hint?.name ?? id,
    template: hint?.template ?? "blank",
    created: hint?.created,
    lastOpened: hint?.lastOpened,
    openInOtherTab: false,
  };
}

function compareWorkspaces(a: StoredWorkspaceSummary, b: StoredWorkspaceSummary): number {
  if (a.openInOtherTab !== b.openInOtherTab) return a.openInOtherTab ? -1 : 1;
  const aTime = a.lastOpened ? Date.parse(a.lastOpened) : 0;
  const bTime = b.lastOpened ? Date.parse(b.lastOpened) : 0;
  if (aTime !== bTime) return bTime - aTime;
  return a.id.localeCompare(b.id);
}

export function listStoredWorkspaces(): Promise<StoredWorkspaceSummary[]> {
  return runSerialized(async () => {
    const { openIdleWorkspace, storedWorkspaces } = await import("waffle");
    const names = await storedWorkspaces("fast");
    const ids = names.flatMap((name) => workspaceIdOf(name) ?? []);
    const results = await Promise.all(
      ids.map((id) =>
        inspectWorkspace(id, openIdleWorkspace).catch(() => {
          const hint = readWorkspaceHint(id);
          return {
            id,
            name: hint?.name ?? id,
            template: hint?.template ?? "blank",
            created: hint?.created,
            lastOpened: hint?.lastOpened,
            openInOtherTab: false,
          };
        }),
      ),
    );
    const summaries = results.filter((entry): entry is StoredWorkspaceSummary => entry !== undefined);
    summaries.sort(compareWorkspaces);
    return summaries;
  });
}

export function deleteStoredWorkspace(id: string): Promise<"deleted" | "missing" | "busy"> {
  return runSerialized(async () => {
    const { deleteWorkspace } = await import("waffle");
    const result = await deleteWorkspace({ mode: "fast", name: storageName(id) });
    if (result !== "busy") removeWorkspaceHint(id);
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
    if (result.status === "renamed") saveWorkspaceHint(id, result.meta);
    return result;
  });
}
