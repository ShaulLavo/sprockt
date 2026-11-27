// What this browser remembers about a workspace without opening its storage: the metadata it
// had when it was last created, renamed, hydrated or listed here. Reactive via `hintRevision`, so
// the title bar, boot screen and explorer update immediately when a workspace's real name is
// hydrated from `/.sprockt/workspace.json` or `package.json`.
import { INCOMPLETE } from "../importer/metadata";
import { createSignal } from "../lib/reactive";
import {
  deriveGitHubWorkspaceName,
  deriveUploadFolderName,
  isGenericWorkspaceName,
  mergeDerivedWorkspaceName,
  packageJsonName,
  parseWorkspaceMeta,
  serializeWorkspaceMeta,
  type WorkspaceMeta,
} from "../templates/workspace-meta";

export const WORKSPACE_HINT_PREFIX = "sprockt:ws-meta:";

const [hintRevision, setHintRevision] = createSignal(0);
/** In-memory fallback used only when `localStorage` throws (private mode or full quota). */
const fallbackHints = new Map<string, WorkspaceMeta>();

function bumpHints(): void {
  setHintRevision((value) => value + 1);
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key.startsWith(WORKSPACE_HINT_PREFIX)) bumpHints();
  });
}

/** The name to show for a workspace: the one it was given, or its id when this browser has none. */
export function workspaceName(id: string): string {
  hintRevision();
  return readWorkspaceHint(id)?.name ?? id;
}

export function readWorkspaceHint(id: string): WorkspaceMeta | undefined {
  try {
    const raw = localStorage.getItem(WORKSPACE_HINT_PREFIX + id);
    if (raw) return parseWorkspaceMeta(raw);
    return fallbackHints.get(id);
  } catch {
    return fallbackHints.get(id);
  }
}

export function saveWorkspaceHint(id: string, meta: WorkspaceMeta): void {
  try {
    localStorage.setItem(WORKSPACE_HINT_PREFIX + id, serializeWorkspaceMeta(meta));
    fallbackHints.delete(id);
  } catch {
    fallbackHints.set(id, meta);
  }
  bumpHints();
}

/** Whether this browser remembers any workspace, known at once, before storage is read. */
export function hasWorkspaceHints(): boolean {
  try {
    return Object.keys(localStorage).some((key) => key.startsWith(WORKSPACE_HINT_PREFIX));
  } catch {
    return fallbackHints.size > 0;
  }
}

export function removeWorkspaceHint(id: string): void {
  fallbackHints.delete(id);
  try {
    localStorage.removeItem(WORKSPACE_HINT_PREFIX + id);
  } catch {
    // Ignore private-mode refusals.
  }
  bumpHints();
}

export function touchWorkspaceHint(id: string): void {
  const existing = readWorkspaceHint(id);
  if (!existing) return;
  saveWorkspaceHint(id, { ...existing, lastOpened: new Date().toISOString() });
}

export interface HydrateWorkspaceNameDeps {
  readMeta(): Promise<string | undefined>;
  writeMeta?(json: string): Promise<void>;
  readPackageJson(): Promise<string | undefined>;
  now?: () => Date;
}

function newerTimestamp(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  if (Number.isNaN(aMs)) return b;
  if (Number.isNaN(bMs)) return a;
  return aMs >= bMs ? a : b;
}

async function persistDerivedMeta(
  deps: HydrateWorkspaceNameDeps,
  state: WorkspaceMeta["state"],
  json: string,
): Promise<void> {
  if (!deps.writeMeta || state === INCOMPLETE) return;
  await deps.writeMeta(json).catch(() => undefined);
}

async function deriveNameFromWorkspace(
  fileMeta: WorkspaceMeta | undefined,
  deps: HydrateWorkspaceNameDeps,
): Promise<string | undefined> {
  if (fileMeta?.source?.kind === "github") {
    return deriveGitHubWorkspaceName(fileMeta.source.repo, fileMeta.source.subdir);
  }
  return packageJsonName(await deps.readPackageJson().catch(() => undefined));
}

/**
 * Hydrates a workspace's display name from `/.sprockt/workspace.json` -> root `package.json`,
 * updating the reactive hint without ever overwriting an explicit user rename.
 */
export async function hydrateWorkspaceName(id: string, deps: HydrateWorkspaceNameDeps): Promise<string> {
  const now = deps.now ? deps.now() : new Date();
  const nowIso = now.toISOString();
  const rawMeta = await deps.readMeta().catch(() => undefined);
  const fileMeta = rawMeta ? parseWorkspaceMeta(rawMeta) : undefined;
  const hint = readWorkspaceHint(id);

  if (fileMeta && !isGenericWorkspaceName(id, fileMeta)) {
    const lastOpened =
      newerTimestamp(newerTimestamp(fileMeta.lastOpened, hint?.lastOpened), nowIso) ?? nowIso;
    saveWorkspaceHint(id, { ...fileMeta, lastOpened });
    return fileMeta.name;
  }

  if (hint?.customName) {
    saveWorkspaceHint(id, { ...hint, lastOpened: newerTimestamp(hint.lastOpened, nowIso) ?? nowIso });
    return hint.name;
  }

  const derived = await deriveNameFromWorkspace(fileMeta, deps);
  if (derived) {
    const { json, meta } = mergeDerivedWorkspaceName(rawMeta, derived, now);
    saveWorkspaceHint(id, meta);
    await persistDerivedMeta(deps, fileMeta?.state, json);
    return derived;
  }

  if (fileMeta) {
    const lastOpened =
      newerTimestamp(newerTimestamp(fileMeta.lastOpened, hint?.lastOpened), nowIso) ?? nowIso;
    saveWorkspaceHint(id, { ...fileMeta, lastOpened });
    return fileMeta.name;
  }

  return hint?.name ?? id;
}

export interface UploadedNameItem {
  readonly path: string;
  readonly data?: Blob;
}

async function uploadedPackageJsonName(items: readonly UploadedNameItem[]): Promise<string | undefined> {
  const rootPkg = items.find((item) => item.path === "package.json" && item.data !== undefined);
  if (!rootPkg?.data) return undefined;
  const text = await rootPkg.data.text().catch(() => undefined);
  return packageJsonName(text);
}

/**
 * Adopts a project name from a root folder upload or uploaded root `package.json` when the
 * workspace still has no real name (never overwrites an explicit rename or named project).
 */
export async function adoptUploadedWorkspaceName(
  id: string,
  items: readonly UploadedNameItem[],
  deps: HydrateWorkspaceNameDeps,
): Promise<string | undefined> {
  const rawMeta = await deps.readMeta().catch(() => undefined);
  const fileMeta = rawMeta ? parseWorkspaceMeta(rawMeta) : undefined;
  const hint = readWorkspaceHint(id);

  if (fileMeta?.customName || hint?.customName) return undefined;
  if (fileMeta && !isGenericWorkspaceName(id, fileMeta)) return undefined;

  const folderName = deriveUploadFolderName(
    items.map((item) => ({ path: item.path, hasData: item.data !== undefined })),
  );
  const derived =
    folderName ??
    (await uploadedPackageJsonName(items)) ??
    packageJsonName(await deps.readPackageJson().catch(() => undefined));
  if (!derived) return undefined;

  const now = deps.now ? deps.now() : new Date();
  const { json, meta } = mergeDerivedWorkspaceName(rawMeta, derived, now);
  saveWorkspaceHint(id, meta);
  await persistDerivedMeta(deps, fileMeta?.state, json);
  return derived;
}
