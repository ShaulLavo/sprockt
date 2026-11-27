// What this browser remembers about a workspace without opening its storage: the metadata it
// had when it was last created, renamed, hydrated or listed here. Reactive via `hintRevision`, so
// the title bar, boot screen and explorer update immediately when a workspace's real name is
// hydrated from `/.sprockt/workspace.json` or `package.json`.
import { INCOMPLETE } from "../importer/metadata";
import { createSignal } from "../lib/reactive";
import {
  deriveGitHubWorkspaceName,
  deriveUploadFolderName,
  isPlaceholderWorkspaceName,
  mergeDerivedWorkspaceName,
  packageJsonName,
  parsePartialWorkspaceMeta,
  parseWorkspaceMeta,
  serializeWorkspaceMeta,
  type PartialWorkspaceMeta,
  type WorkspaceMeta,
} from "../templates/workspace-meta";

export const WORKSPACE_HINT_PREFIX = "sprockt:ws-meta:";
export const WORKSPACE_PENDING_NAME_PREFIX = "sprockt:ws-pending-name:";

const [hintRevision, setHintRevision] = createSignal(0);
/**
 * In-memory fallback populated only when `localStorage.setItem` throws (private mode or full
 * quota). Preferred over stale `localStorage` entries until another write succeeds or storage
 * changes externally.
 */
const fallbackHints = new Map<string, WorkspaceMeta>();
const fallbackPendingNames = new Map<string, string>();
/** Per-workspace in-process lock tail so concurrent callers serialize even without Web Locks. */
const nameLockQueues = new Map<string, Promise<unknown>>();

function bumpHints(): void {
  setHintRevision((value) => value + 1);
}

function readPendingWorkspaceName(id: string): string | undefined {
  const fallback = fallbackPendingNames.get(id);
  if (fallback) return fallback;
  try {
    const raw = localStorage.getItem(WORKSPACE_PENDING_NAME_PREFIX + id)?.trim();
    return raw || undefined;
  } catch {
    return undefined;
  }
}

function savePendingWorkspaceName(id: string, name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  try {
    localStorage.setItem(WORKSPACE_PENDING_NAME_PREFIX + id, trimmed);
    fallbackPendingNames.delete(id);
  } catch {
    fallbackPendingNames.set(id, trimmed);
  }
}

function clearPendingWorkspaceName(id: string): void {
  fallbackPendingNames.delete(id);
  try {
    localStorage.removeItem(WORKSPACE_PENDING_NAME_PREFIX + id);
  } catch {
    // Ignore private-mode refusals.
  }
}

/** Clears a pending name once its hint is durable in localStorage or replaced by a different name. */
function clearPendingIfReplacedOrDurable(id: string, name: string): void {
  if (!fallbackHints.has(id) || readPendingWorkspaceName(id) !== name) {
    clearPendingWorkspaceName(id);
  }
}

/** Handles cross-tab `storage` events; exported for unit testing. */
export function handleHintStorageEvent(key: string | null): void {
  if (key === null) {
    fallbackHints.clear();
    fallbackPendingNames.clear();
    bumpHints();
    return;
  }
  if (key.startsWith(WORKSPACE_PENDING_NAME_PREFIX)) {
    fallbackPendingNames.delete(key.slice(WORKSPACE_PENDING_NAME_PREFIX.length));
    return;
  }
  if (!key.startsWith(WORKSPACE_HINT_PREFIX)) return;
  fallbackHints.delete(key.slice(WORKSPACE_HINT_PREFIX.length));
  bumpHints();
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => handleHintStorageEvent(event.key));
}

/** The name to show for a workspace: the one it was given, or its id when this browser has none. */
export function workspaceName(id: string): string {
  hintRevision();
  return readWorkspaceHint(id)?.name ?? id;
}

export function readWorkspaceHint(id: string): WorkspaceMeta | undefined {
  const fallback = fallbackHints.get(id);
  if (fallback) return fallback;
  try {
    const raw = localStorage.getItem(WORKSPACE_HINT_PREFIX + id);
    return raw ? parseWorkspaceMeta(raw) : undefined;
  } catch {
    return undefined;
  }
}

export function saveWorkspaceHint(id: string, meta: WorkspaceMeta): void {
  const pending = readPendingWorkspaceName(id);
  try {
    localStorage.setItem(WORKSPACE_HINT_PREFIX + id, serializeWorkspaceMeta(meta));
    fallbackHints.delete(id);
    if (!isPlaceholderWorkspaceName(meta)) clearPendingWorkspaceName(id);
  } catch {
    fallbackHints.set(id, meta);
    // Keep a matching pending name in localStorage until either the full hint or workspace.json
    // is stored durably; clear it immediately only when replaced by a different explicit name.
    if (!isPlaceholderWorkspaceName(meta) && pending !== meta.name) {
      clearPendingWorkspaceName(id);
    }
  }
  bumpHints();
}

/** Whether this browser remembers any workspace, known at once, before storage is read. */
export function hasWorkspaceHints(): boolean {
  if (fallbackHints.size > 0) return true;
  try {
    return Object.keys(localStorage).some((key) => key.startsWith(WORKSPACE_HINT_PREFIX));
  } catch {
    return false;
  }
}

export function removeWorkspaceHint(id: string): void {
  clearPendingWorkspaceName(id);
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
  readonly signal?: AbortSignal;
  now?: () => Date;
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  return new DOMException("The operation was aborted.", "AbortError");
}

function waitUnlessAborted(promise: Promise<unknown>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return promise.then(() => undefined);
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.finally(() => {
      signal.removeEventListener("abort", onAbort);
      if (!signal.aborted) resolve();
    });
  });
}

/** Serializes metadata read-modify-write per workspace within this tab and across attached tabs. */
export function withWorkspaceMetaLock<T>(
  id: string,
  task: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  const runInBrowserLock = (): Promise<T> => {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    if (typeof navigator === "undefined" || !navigator.locks) return task();
    return signal
      ? navigator.locks.request(`sprockt:${id}:meta-name`, { signal }, task)
      : navigator.locks.request(`sprockt:${id}:meta-name`, task);
  };
  const previous = nameLockQueues.get(id) ?? Promise.resolve();
  const next = waitUnlessAborted(previous, signal).then(runInBrowserLock);
  // Keep the queue tail chained to `previous` too so aborting a queued waiter never lets a
  // later caller overlap with the still-active holder.
  const tail = Promise.allSettled([previous, next]).then(() => undefined);
  nameLockQueues.set(id, tail);
  void tail.finally(() => {
    if (nameLockQueues.get(id) === tail) nameLockQueues.delete(id);
  });
  return next;
}

/**
 * Merges disk metadata read on the landing page with an existing browser hint, preserving a
 * pending adopted name when disk still holds a placeholder (e.g. after a transient write failure).
 */
export function mergeStoredWorkspaceMeta(
  id: string,
  diskMeta: WorkspaceMeta,
  hint: WorkspaceMeta | undefined,
): WorkspaceMeta {
  const lastOpened = newerTimestamp(diskMeta.lastOpened, hint?.lastOpened) ?? diskMeta.lastOpened;
  if (!isPlaceholderWorkspaceName(diskMeta)) return { ...diskMeta, lastOpened };
  const candidate =
    hint && !isPlaceholderWorkspaceName(hint) && hint.name !== id ? hint.name : readPendingWorkspaceName(id);
  if (!candidate) return { ...diskMeta, lastOpened };
  const { defaultName: _placeholder, ...rest } = diskMeta;
  return { ...rest, name: candidate, lastOpened };
}

type MetaRead = { readonly ok: true; readonly raw: string | undefined } | { readonly ok: false };

async function readMetaStrict(deps: HydrateWorkspaceNameDeps): Promise<MetaRead> {
  try {
    return { ok: true, raw: await deps.readMeta() };
  } catch {
    return { ok: false };
  }
}

/** Whether `raw` is absent or a JSON object we can safely merge into without clobbering corrupt data. */
function canMergeMetaRaw(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
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
  id: string,
  deps: HydrateWorkspaceNameDeps,
  state: WorkspaceMeta["state"],
  json: string,
): Promise<void> {
  if (!deps.writeMeta || state === INCOMPLETE) return;
  const written = await deps.writeMeta(json).then(
    () => true,
    () => false,
  );
  if (written) clearPendingWorkspaceName(id);
}

async function deriveNameFromWorkspace(
  id: string,
  partial: PartialWorkspaceMeta | undefined,
  deps: HydrateWorkspaceNameDeps,
): Promise<string | undefined> {
  if (partial?.source?.kind === "github") {
    return deriveGitHubWorkspaceName(partial.source.repo, partial.source.subdir);
  }
  const pending = readPendingWorkspaceName(id);
  if (pending) return pending;
  return packageJsonName(await deps.readPackageJson().catch(() => undefined));
}

function hintFromPartial(
  partial: PartialWorkspaceMeta,
  name: string,
  hint: WorkspaceMeta | undefined,
  nowIso: string,
): WorkspaceMeta {
  const lastOpened = newerTimestamp(newerTimestamp(partial.lastOpened, hint?.lastOpened), nowIso) ?? nowIso;
  const source = partial.source ?? hint?.source;
  return {
    name,
    template: partial.template ?? hint?.template ?? "blank",
    created: partial.created ?? hint?.created ?? nowIso,
    lastOpened,
    ...(partial.state ? { state: partial.state } : {}),
    ...(source ? { source } : {}),
  };
}

async function commitDerivedHydration(
  id: string,
  derived: string,
  latestHint: WorkspaceMeta | undefined,
  deps: HydrateWorkspaceNameDeps,
  now: Date,
  nowIso: string,
): Promise<string> {
  // Re-read metadata before merging so a concurrent writer (e.g. an import writing `source` and
  // `pendingImport`) is never clobbered by a stale snapshot.
  const freshRead = await readMetaStrict(deps);
  if (!freshRead.ok || deps.signal?.aborted) return readWorkspaceHint(id)?.name ?? id;
  const freshRaw = freshRead.raw;
  const freshFile = freshRaw ? parseWorkspaceMeta(freshRaw) : undefined;
  const freshPartial = parsePartialWorkspaceMeta(freshRaw);
  if (freshFile && !isPlaceholderWorkspaceName(freshFile)) {
    const lastOpened =
      newerTimestamp(newerTimestamp(freshFile.lastOpened, latestHint?.lastOpened), nowIso) ?? nowIso;
    clearPendingWorkspaceName(id);
    saveWorkspaceHint(id, { ...freshFile, lastOpened });
    return freshFile.name;
  }
  if (freshPartial?.name && !freshPartial.defaultName) {
    clearPendingWorkspaceName(id);
    saveWorkspaceHint(id, hintFromPartial(freshPartial, freshPartial.name, latestHint, nowIso));
    return freshPartial.name;
  }
  const { json, meta } = mergeDerivedWorkspaceName(freshRaw, derived, now);
  saveWorkspaceHint(id, meta);
  if (canMergeMetaRaw(freshRaw)) await persistDerivedMeta(id, deps, freshPartial?.state, json);
  return derived;
}

/**
 * Hydrates a workspace's display name from `/.sprockt/workspace.json` -> root `package.json`,
 * updating the reactive hint without ever overwriting an explicit user rename, legacy name,
 * or unreadable metadata file. Retries persisting a non-placeholder hint name if an earlier
 * metadata write failed transiently.
 */
export function hydrateWorkspaceName(id: string, deps: HydrateWorkspaceNameDeps): Promise<string> {
  return withWorkspaceMetaLock(
    id,
    async () => {
      if (deps.signal?.aborted) return readWorkspaceHint(id)?.name ?? id;
      const now = deps.now ? deps.now() : new Date();
      const nowIso = now.toISOString();
      const metaRead = await readMetaStrict(deps);
      const hint = readWorkspaceHint(id);
      if (!metaRead.ok || deps.signal?.aborted) return hint?.name ?? id;

      const rawMeta = metaRead.raw;
      const fileMeta = rawMeta ? parseWorkspaceMeta(rawMeta) : undefined;
      const partial = parsePartialWorkspaceMeta(rawMeta);

      if (fileMeta && !isPlaceholderWorkspaceName(fileMeta)) {
        const lastOpened =
          newerTimestamp(newerTimestamp(fileMeta.lastOpened, hint?.lastOpened), nowIso) ?? nowIso;
        clearPendingWorkspaceName(id);
        saveWorkspaceHint(id, { ...fileMeta, lastOpened });
        return fileMeta.name;
      }

      // Preserve any non-placeholder saved name on disk (along with its valid template/source/state)
      // even if `workspace.json` lacks timestamps.
      if (partial?.name && !partial.defaultName) {
        clearPendingWorkspaceName(id);
        saveWorkspaceHint(id, hintFromPartial(partial, partial.name, hint, nowIso));
        return partial.name;
      }

      // If an earlier adoption/rename saved a real hint while disk still holds a placeholder or
      // nothing, retry persisting it to disk so clearing browser storage never loses the name.
      if (hint && !isPlaceholderWorkspaceName(hint) && hint.name !== id) {
        const { json, meta } = mergeDerivedWorkspaceName(rawMeta, hint.name, now);
        const lastOpened = newerTimestamp(hint.lastOpened, nowIso) ?? nowIso;
        saveWorkspaceHint(id, { ...meta, lastOpened });
        if (canMergeMetaRaw(rawMeta)) await persistDerivedMeta(id, deps, partial?.state, json);
        return hint.name;
      }

      const derived = await deriveNameFromWorkspace(id, partial, deps);
      const latestHint = readWorkspaceHint(id);
      if (deps.signal?.aborted) return latestHint?.name ?? id;
      if (latestHint && !isPlaceholderWorkspaceName(latestHint) && latestHint.name !== id) {
        return latestHint.name;
      }
      if (derived) return commitDerivedHydration(id, derived, latestHint, deps, now, nowIso);

      if (fileMeta) {
        const lastOpened =
          newerTimestamp(newerTimestamp(fileMeta.lastOpened, latestHint?.lastOpened), nowIso) ?? nowIso;
        saveWorkspaceHint(id, { ...fileMeta, lastOpened });
        return fileMeta.name;
      }

      return latestHint?.name ?? id;
    },
    deps.signal,
  );
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
 * workspace still has no real name (never overwrites an explicit rename, named project, or
 * unreadable metadata file). Records a folder-name candidate synchronously before acquiring the
 * workspace lock so leaving while another tab holds the lock never drops the uploaded folder name.
 */
export function adoptUploadedWorkspaceName(
  id: string,
  items: readonly UploadedNameItem[],
  deps: HydrateWorkspaceNameDeps,
): Promise<string | undefined> {
  if (deps.signal?.aborted) return Promise.resolve(undefined);
  const folderName = deriveUploadFolderName(
    items.map((item) => ({ path: item.path, hasData: item.data !== undefined })),
  );
  const currentHint = readWorkspaceHint(id);
  const hasRealHint = currentHint && !isPlaceholderWorkspaceName(currentHint) && currentHint.name !== id;
  if (!hasRealHint && folderName && !readPendingWorkspaceName(id)) {
    savePendingWorkspaceName(id, folderName);
  }
  return withWorkspaceMetaLock(
    id,
    async () => {
      if (deps.signal?.aborted) return undefined;
      const metaRead = await readMetaStrict(deps);
      if (!metaRead.ok || deps.signal?.aborted) return undefined;

      const rawMeta = metaRead.raw;
      const fileMeta = rawMeta ? parseWorkspaceMeta(rawMeta) : undefined;
      const partial = parsePartialWorkspaceMeta(rawMeta);
      const hint = readWorkspaceHint(id);

      if (fileMeta && !isPlaceholderWorkspaceName(fileMeta)) {
        clearPendingWorkspaceName(id);
        return undefined;
      }
      if (partial?.name && !partial.defaultName) {
        clearPendingWorkspaceName(id);
        return undefined;
      }
      if (hint && !isPlaceholderWorkspaceName(hint) && hint.name !== id) {
        clearPendingIfReplacedOrDurable(id, hint.name);
        return undefined;
      }

      const derived =
        folderName ??
        (await uploadedPackageJsonName(items)) ??
        packageJsonName(await deps.readPackageJson().catch(() => undefined));
      if (!derived || deps.signal?.aborted) return undefined;
      const latestHint = readWorkspaceHint(id);
      if (latestHint && !isPlaceholderWorkspaceName(latestHint) && latestHint.name !== id) {
        clearPendingIfReplacedOrDurable(id, latestHint.name);
        return undefined;
      }

      const freshRead = await readMetaStrict(deps);
      if (!freshRead.ok || deps.signal?.aborted) return undefined;
      const freshRaw = freshRead.raw;
      const freshFile = freshRaw ? parseWorkspaceMeta(freshRaw) : undefined;
      const freshPartial = parsePartialWorkspaceMeta(freshRaw);
      if (freshFile && !isPlaceholderWorkspaceName(freshFile)) {
        clearPendingWorkspaceName(id);
        return undefined;
      }
      if (freshPartial?.name && !freshPartial.defaultName) {
        clearPendingWorkspaceName(id);
        return undefined;
      }

      const now = deps.now ? deps.now() : new Date();
      const { json, meta } = mergeDerivedWorkspaceName(freshRaw, derived, now);
      saveWorkspaceHint(id, meta);
      if (canMergeMetaRaw(freshRaw)) await persistDerivedMeta(id, deps, freshPartial?.state, json);
      return derived;
    },
    deps.signal,
  );
}
