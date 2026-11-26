// Text storage does not hold yet is left in localStorage whenever this tab may stop running: when
// the page is hidden (a phone switching apps may never come back to it) and when another tab takes
// the workspace over. The next tab that opens the file, in this browser, shows it as an unsaved
// edit, or as a conflict when the file changed since.
//
// Each tab leaves its own entries, one key per file, so two tabs never overwrite each other's
// text. A tab holds a Web Lock while it can still save its own text; a draft whose tab holds that
// lock is that tab's business and is not taken by another one. An entry stays until its text is
// safely in storage or the person discards it; opening the file does not remove it.

/** Unsaved text of one file. */
export interface Draft {
  readonly text: string;
  /** What the file held when this text was last in step with it; absent: it did not exist. */
  readonly baseText?: string | undefined;
}

/** A draft some tab left, with where it is stored. */
export interface LeftDraft extends Draft {
  readonly key: string;
  readonly tab: string;
  /** When it was left, in milliseconds since the epoch. */
  readonly at: number;
}

type TextStore = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

/** `v2`: one key per workspace, file and tab. A path is URI-encoded, so it holds no `:`. */
const PREFIX = "sprockt:recovery:v2:";
const fileKey = (workspace: string, path: string) => `${PREFIX}${workspace}:${encodeURIComponent(path)}:`;
/** The key a tab leaves a file's text under. */
export const draftKey = (workspace: string, path: string, tab: string) => fileKey(workspace, path) + tab;

const isStored = (value: unknown): value is Draft & { readonly at: number } =>
  typeof value === "object" &&
  value !== null &&
  "text" in value &&
  typeof value.text === "string" &&
  "at" in value &&
  typeof value.at === "number" &&
  (!("baseText" in value) || value.baseText === undefined || typeof value.baseText === "string");

function keysStartingWith(storage: TextStore, prefix: string): string[] {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(prefix)) keys.push(key);
  }
  return keys;
}

function read(storage: TextStore, key: string): LeftDraft | undefined {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(key) ?? "null");
    if (!isStored(parsed)) return undefined;
    const tab = key.slice(key.lastIndexOf(":") + 1);
    return { text: parsed.text, baseText: parsed.baseText, at: parsed.at, key, tab };
  } catch {
    return undefined;
  }
}

function remove(storage: TextStore, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // Storage blocked: there is nothing stored to remove either.
  }
}

/**
 * Leaves this tab's unsaved text for each file, replacing what it left before: a file saved or
 * closed since loses its entry. Other tabs' entries are not touched.
 */
export function leaveForRecovery(
  storage: TextStore,
  workspace: string,
  tab: string,
  drafts: ReadonlyMap<string, Draft>,
  now = Date.now(),
): void {
  const keep = new Set(Array.from(drafts.keys(), (path) => draftKey(workspace, path, tab)));
  const mine = keysStartingWith(storage, `${PREFIX}${workspace}:`).filter((key) => key.endsWith(`:${tab}`));
  for (const key of mine) if (!keep.has(key)) remove(storage, key);
  for (const [path, draft] of drafts) {
    try {
      const value = { text: draft.text, baseText: draft.baseText, at: now };
      storage.setItem(draftKey(workspace, path, tab), JSON.stringify(value));
    } catch {
      // Storage full or blocked: this text has no other copy than the page, as before.
    }
  }
}

/** Every draft any tab left for one file. */
export function draftsLeftFor(storage: TextStore, workspace: string, path: string): LeftDraft[] {
  try {
    return keysStartingWith(storage, fileKey(workspace, path)).flatMap((key) => read(storage, key) ?? []);
  } catch {
    return [];
  }
}

/**
 * The draft to show for a file: the newest one whose tab can no longer save it (`held` says a
 * live tab still holds it). `keys` are that entry and every other such entry with the same text,
 * to be removed together once the text is durable. A different text from another gone tab stays
 * stored, and is offered when the file is opened again after this one was settled.
 */
export function pickRecovered(
  drafts: readonly LeftDraft[],
  held: (tab: string) => boolean,
): { readonly draft: Draft; readonly keys: readonly string[] } | undefined {
  const free = drafts.filter((draft) => !held(draft.tab)).toSorted((a, b) => b.at - a.at);
  const newest = free[0];
  if (!newest) return undefined;
  const same = free.filter((draft) => draft.text === newest.text && draft.baseText === newest.baseText);
  return {
    draft: { text: newest.text, baseText: newest.baseText },
    keys: same.map((draft) => draft.key),
  };
}

/** Call once the file's text is safely in storage, or the person chose to drop it. */
export function discardRecovered(storage: TextStore, keys: readonly string[]): void {
  for (const key of keys) remove(storage, key);
}

/** One tab's side of recovery: what it leaves, what it took from gone tabs, and when they go. */
export interface DraftKeeper {
  /** The draft to show when `path` is opened in this tab, if a tab that can no longer save left one. */
  recover(path: string, version?: number): Promise<Draft | undefined>;
  /** Paths of drafts left by gone tabs that match `match` (for discovering detached drafts). */
  recoverablePaths(match: (path: string) => boolean): Promise<string[]>;
  /** Leaves this tab's unsaved text, replacing what it left before (page hidden, workspace lost). */
  leave(drafts: ReadonlyMap<string, Draft>, versions?: ReadonlyMap<string, number>): void;
  /**
   * Removes recovery entries for `path`. Without `version`, removes unconditionally (close,
   * reload from disk). With `version`, removes only entries covered by that durable write.
   */
  settled(path: string, version?: number): void;
  /** Entries follow a file or folder this tab saw move. */
  renamed(from: string, to: string): void;
  /**
   * Drafts taken from other tabs at exactly `from` move to `to` when the text set aside there
   * (at `version`) covers them, so its durable save clears them. Returns whether they moved.
   */
  handedOver(from: string, to: string, version: number): boolean;
  /** This tab can no longer save (or is closing): other tabs may take what it left. */
  release(): void;
}

export interface DraftKeeperOptions {
  readonly storage: TextStore;
  readonly workspace: string;
  readonly tab: string;
  readonly locks: LockManager | undefined;
  /** Where a path is after a move (`tabs.ts` renamedPath). */
  renamedPath(path: string, from: string, to: string): string;
  now?(): number;
}

function parseRecoveryKey(
  key: string,
  prefix: string,
): { readonly path: string; readonly owner: string } | undefined {
  const rest = key.slice(prefix.length);
  const separator = rest.lastIndexOf(":");
  if (separator <= 0) return undefined;
  try {
    return { path: decodeURIComponent(rest.slice(0, separator)), owner: rest.slice(separator + 1) };
  } catch {
    return undefined;
  }
}

export function createDraftKeeper(options: DraftKeeperOptions): DraftKeeper {
  const { storage, workspace, tab } = options;
  const releaseLease = holdTabLease(tab, options.locks);
  /** Entries other tabs left that this tab showed, by the path they are open at here. */
  const taken = new Map<string, { readonly keys: readonly string[]; readonly version: number }>();
  /** The monotonic version of each entry this tab last wrote via `leave`, by path. */
  const ownVersions = new Map<string, number>();

  /** This tab's own entries, by the path they are for. */
  function ownEntries(): Map<string, string> {
    const own = new Map<string, string>();
    const prefix = `${PREFIX}${workspace}:`;
    for (const key of keysStartingWith(storage, prefix)) {
      if (!key.endsWith(`:${tab}`)) continue;
      const parsed = parseRecoveryKey(key, prefix);
      if (parsed) own.set(parsed.path, key);
    }
    return own;
  }

  function matchingStored(
    match: (path: string) => boolean,
  ): { readonly path: string; readonly owner: string; readonly at: number }[] {
    try {
      const prefix = `${PREFIX}${workspace}:`;
      const found: { readonly path: string; readonly owner: string; readonly at: number }[] = [];
      for (const key of keysStartingWith(storage, prefix)) {
        const parsed = parseRecoveryKey(key, prefix);
        if (!parsed || !match(parsed.path)) continue;
        const draft = read(storage, key);
        if (draft) found.push({ path: parsed.path, owner: parsed.owner, at: draft.at });
      }
      return found;
    } catch {
      return [];
    }
  }

  function moveOwn(path: string, key: string, from: string, to: string): void {
    const target = options.renamedPath(path, from, to);
    if (target === path) return;
    const value = storage.getItem(key);
    remove(storage, key);
    if (value !== null) storage.setItem(draftKey(workspace, target, tab), value);
  }

  function renameMap<V>(map: Map<string, V>, from: string, to: string): void {
    const moved = Array.from(map.entries()).filter(([path]) => options.renamedPath(path, from, to) !== path);
    for (const [path] of moved) map.delete(path);
    for (const [path, value] of moved) map.set(options.renamedPath(path, from, to), value);
  }

  return {
    async recover(path, version = 0) {
      const left = draftsLeftFor(storage, workspace, path);
      if (left.length === 0) return undefined;
      const live = await liveTabs(options.locks);
      const picked = pickRecovered(left, (owner) => owner !== tab && live.has(owner));
      if (!picked) return undefined;
      taken.set(path, { keys: picked.keys, version });
      return picked.draft;
    },
    async recoverablePaths(match) {
      const entries = matchingStored(match);
      if (entries.length === 0) return [];
      const live = await liveTabs(options.locks);
      const paths = new Set<string>();
      for (const entry of entries.toSorted((a, b) => b.at - a.at)) {
        if (entry.owner !== tab && live.has(entry.owner)) continue;
        paths.add(entry.path);
      }
      return Array.from(paths);
    },
    leave(drafts, versions) {
      leaveForRecovery(storage, workspace, tab, drafts, options.now?.());
      ownVersions.clear();
      for (const path of drafts.keys()) ownVersions.set(path, versions?.get(path) ?? 0);
    },
    settled(path, version) {
      const takenEntry = taken.get(path);
      const ownVersion = ownVersions.get(path);
      if (version === undefined) {
        discardRecovered(storage, (takenEntry?.keys ?? []).concat([draftKey(workspace, path, tab)]));
        taken.delete(path);
        ownVersions.delete(path);
        return;
      }
      const keys: string[] = [];
      if (takenEntry && takenEntry.version <= version) {
        keys.push(...takenEntry.keys);
        taken.delete(path);
      }
      if (ownVersion !== undefined && ownVersion <= version) {
        keys.push(draftKey(workspace, path, tab));
        ownVersions.delete(path);
      }
      if (keys.length > 0) discardRecovered(storage, keys);
    },
    handedOver(from, to, version) {
      const entry = taken.get(from);
      if (!entry || entry.version > version) return false;
      taken.delete(from);
      taken.set(to, entry);
      return true;
    },
    renamed(from, to) {
      renameMap(taken, from, to);
      renameMap(ownVersions, from, to);
      try {
        for (const [path, key] of ownEntries()) moveOwn(path, key, from, to);
      } catch {
        // Storage blocked: nothing of this tab's is stored to move.
      }
    },
    release: releaseLease,
  };
}

const LEASE_PREFIX = "sprockt:editor-tab:";

/**
 * Holds this tab's lock while it can still save its own drafts; the returned function lets go
 * (the tab lost the workspace). Closing the page lets go too.
 */
export function holdTabLease(tab: string, locks: LockManager | undefined): () => void {
  if (!locks) return () => {};
  const done = Promise.withResolvers<void>();
  void locks.request(LEASE_PREFIX + tab, () => done.promise).catch(() => {});
  return () => done.resolve();
}

/** The tabs that still hold their lock. Without Web Locks, none: every draft can be taken. */
export async function liveTabs(locks: LockManager | undefined): Promise<ReadonlySet<string>> {
  if (!locks) return new Set();
  const state = await locks.query().catch(() => ({ held: [] }));
  const names = (state.held ?? []).flatMap((lock) => lock.name ?? []);
  return new Set(
    names.filter((name) => name.startsWith(LEASE_PREFIX)).map((name) => name.slice(LEASE_PREFIX.length)),
  );
}
