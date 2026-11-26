// One Singapore text buffer per open file. Files are the source of truth: a buffer remembers the
// disk text it was last in step with, follows the disk while it is clean, and holds a conflict
// when the disk moves under unsaved edits. Undo history, carets and scroll live in the buffer's
// session, so switching tabs keeps them.
//
// The rules: a save writes a buffer's own text to its own path; it writes only if the file still
// holds what the buffer was last in step with (otherwise it becomes a conflict); saves of one file
// run in order; "dirty" means the text differs from what is on disk (or being written), whatever
// undo or redo did meanwhile; unsaved text is never dropped by switching files.
import {
  createEditorBufferSession,
  createEditorTextBuffer,
  pieceTableSnapshotsHaveSameText,
  type EditorBufferSession,
  type PieceTableSnapshot,
} from "@singapore-editor/core/document";
import type { EditorScrollPosition } from "@singapore-editor/core/editor";
import { createSignal, type Accessor } from "solid-js";
import type { FileService } from "../files/service";
import { EDITOR_COPY, fill } from "./copy";
import { replacementBetween } from "./diff";
import type { Draft } from "./recovery";
import { renamedPath } from "./tabs";

/** The file on disk no longer holds what the buffer was last in step with. */
export interface Conflict {
  /** What the file holds now; undefined when it was deleted. */
  readonly diskText: string | undefined;
}

const isSameOrInside = (path: string, other: string) => path === other || path.startsWith(`${other}/`);
const under = (path: string, roots: readonly string[]) => roots.some((root) => isSameOrInside(path, root));

/**
 * A draft pushed aside by a move keeps its text under a key that is no project path at all (it
 * starts with a NUL, which FileService refuses), so no file can ever open at it. Saving such a
 * draft picks a real, free name at that moment.
 */
const DETACHED = "\u0000unsaved:";

let detachedCount = 0;

export function detachedKey(original: string): string {
  detachedCount += 1;
  return `${DETACHED}${detachedCount}/${original}`;
}

export const isDetached = (key: string) => key.startsWith(DETACHED);

/** The path a detached draft came from, or the key itself for an ordinary path. */
export function originalPath(key: string): string {
  if (!isDetached(key)) return key;
  return key.slice(key.indexOf("/") + 1);
}

/** An unsaved draft moved out of the way of a file that moved onto its path. */
export interface PathLock {
  release(): void;
}

export interface Displacement {
  readonly from: string;
  readonly to: string;
  /**
   * True when the buffer open at `from` moved aside (its tab follows it); false when only a pending
   * write that no open buffer holds was set aside (it gets a tab of its own).
   */
  readonly buffer: boolean;
}

/** `dir/a.txt` becomes `dir/a (draft).txt`, then `dir/a (draft 2).txt`, until one is free. */
export function freeName(path: string, taken: (path: string) => boolean): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  const split = dot > slash + 1 ? dot : path.length;
  const stem = path.slice(0, split);
  const extension = path.slice(split);
  for (let count = 1; ; count += 1) {
    const candidate =
      count === 1
        ? fill(EDITOR_COPY.savedDraftName, { stem, extension })
        : fill(EDITOR_COPY.savedDraftNameNumbered, { stem, count, extension });
    if (!taken(candidate)) return candidate;
  }
}

export interface Buffer {
  /** Project-relative path. Changes only through `BufferSet.rename`. */
  readonly path: string;
  readonly session: EditorBufferSession;
  readonly dirty: Accessor<boolean>;
  readonly conflict: Accessor<Conflict | undefined>;
  /** The file is gone from disk; saving writes it again. */
  readonly missing: Accessor<boolean>;
  /** Where the view was scrolled when it last showed this buffer. */
  scroll: EditorScrollPosition | undefined;
}

export interface SaveOptions {
  readonly when?: (buffer: Buffer) => boolean;
}

export interface BufferSet {
  /** The loaded buffer for a path. Reactive: re-runs when buffers load, close or move. */
  get(path: string): Buffer | undefined;
  /** The buffer for a file, read on first use. Undefined when the file does not exist. */
  load(path: string): Promise<Buffer | undefined>;
  release(path: string): void;
  /**
   * Buffers follow a move. A buffer with unsaved text already at a destination is moved aside to
   * a free name rather than dropped; the returned list says where each went.
   */
  rename(from: string, to: string): Displacement[];
  /**
   * Locks paths (and everything inside them) for a move: resolves once writes already running
   * there have finished, and from then until `release`, saves to those paths wait. A save that
   * waited writes to its buffer's path as it is after the move.
   */
  lock(roots: readonly string[]): Promise<PathLock>;
  /** Files (and everything inside folders) deleted: their buffers stay, marked deleted, text kept. */
  markRemoved(paths: readonly string[]): void;
  /**
   * Writes the buffer's text to its own path if the file still holds what the buffer was last in
   * step with; otherwise the buffer gets a conflict. Edits made while the write runs stay unsaved.
   * `when` is asked right before the write starts, after any earlier save of the file and any
   * move lock: a save that is no longer wanted by then (autosave of a file deleted meanwhile, or
   * of text already written) writes nothing.
   */
  save(path: string, options?: SaveOptions): Promise<void>;
  /** Compares every buffer with the disk: reload clean ones, flag conflicts on dirty ones. */
  sync(): Promise<void>;
  /** Resolve a conflict by keeping the buffer: the next save expects what is on disk now. */
  keepMine(path: string): Promise<void>;
  /** Resolve a conflict by replacing the buffer with what the file holds now. */
  takeTheirs(path: string): Promise<void>;
  /** Paths of every loaded buffer. */
  paths(): string[];
  /**
   * Everything storage does not hold yet, to hand to the tab that takes the workspace over:
   * unsaved edits, and saved text whose flush has not finished (even of a closed tab).
   */
  unsaved(): ReadonlyMap<string, Draft>;
  /** Unsaved text together with the buffer version each entry represents, for durability matching. */
  unsavedSnapshot(): UnsavedSnapshot;
  readonly dirtyPaths: Accessor<readonly string[]>;
  dispose(): void;
}

export interface UnsavedSnapshot {
  readonly drafts: ReadonlyMap<string, Draft>;
  readonly versions: ReadonlyMap<string, number>;
}

interface Entry {
  buffer: Buffer & { path: string };
  /** Monotonic version incremented on edits/loads/detach, matched against durable flushes. */
  version: number;
  /** The disk text this buffer was last in step with; undefined: the file did not exist. */
  disk: string | undefined;
  /** The buffer's text as it is on disk: "dirty" means the text differs from this. */
  persisted: PieceTableSnapshot;
  /** The text a running save is writing; while set, "dirty" compares against it instead. */
  inflight: PieceTableSnapshot | undefined;
  saving: number;
  /**
   * A save of this text was acknowledged, but storage may not hold it: its flush failed, or the
   * files came back from storage (another tab hosting them now) without it. The buffer stays
   * unsaved until a later save of it is durable.
   */
  unconfirmed: boolean;
  /** True while we edit the buffer ourselves, so a reload is not mistaken for typing. */
  applying: boolean;
  setDirty(dirty: boolean): void;
  setConflict(conflict: Conflict | undefined): void;
  setMissing(missing: boolean): void;
  unsubscribe(): void;
}

type Files = Pick<FileService, "read" | "writeIfUnchanged" | "saved">;

export interface BufferSetOptions {
  /** Hears about the first unsaved edit after each clean state: the editor pins previews. */
  readonly onEdit?: (path: string) => void;
  /** Hears about every edit the person makes (not reloads from disk): autosave waits for a pause. */
  readonly onChange?: (path: string) => void;
  /** Unsaved text another tab left behind for a file, applied when the file is opened. */
  readonly recover?: (path: string, version: number) => Draft | undefined | Promise<Draft | undefined>;
  /** A file's saved text has reached storage: recovery entries up to `version` are covered. */
  readonly onDurable?: (path: string, version: number) => void;
}

export function createBufferSet(files: Files, options: BufferSetOptions = {}): BufferSet {
  const entries = new Map<string, Entry>();
  const loading = new Map<string, Promise<Buffer | undefined>>();
  const [dirtyPaths, setDirtyPaths] = createSignal<readonly string[]>([]);
  // Moves whenever buffers come, go or move, so `get` can be read reactively.
  const [generation, setGeneration] = createSignal(0);
  let versionSeq = 0;
  const nextVersion = () => (versionSeq += 1);
  let syncing: Promise<void> | undefined;
  let syncAgain = false;

  function publishDirty(): void {
    setDirtyPaths(
      Array.from(entries.values()).flatMap((entry) => (entry.buffer.dirty() ? [entry.buffer.path] : [])),
    );
  }

  function membershipChanged(): void {
    setGeneration((value) => value + 1);
    publishDirty();
  }

  /**
   * Unsaved means the text differs from what is on disk, or from what a running save is writing.
   * Compared by content, not by history position: an undo made while a save runs is unsaved.
   * Cheap in the usual cases: equal snapshots, a different length or a shared tree answer at once.
   */
  function isUnsaved(entry: Entry): boolean {
    if (entry.unconfirmed || isDetached(entry.buffer.path)) return true;
    const current = entry.buffer.session.getSnapshot();
    // Clean only when the text is on disk and no running save is about to replace it with
    // something else: a write is not counted until it has succeeded.
    if (!pieceTableSnapshotsHaveSameText(current, entry.persisted)) return true;
    return entry.inflight !== undefined && !pieceTableSnapshotsHaveSameText(current, entry.inflight);
  }

  function refreshDirty(entry: Entry): void {
    const dirty = isUnsaved(entry);
    if (dirty === entry.buffer.dirty()) return;
    entry.setDirty(dirty);
    publishDirty();
    if (dirty && !entry.applying) options.onEdit?.(entry.buffer.path);
  }

  function create(path: string, text: string | undefined, version = nextVersion()): Entry {
    const session = createEditorBufferSession(createEditorTextBuffer(text ?? ""));
    const [dirty, setDirty] = createSignal(false);
    const [conflict, setConflict] = createSignal<Conflict>();
    const [missing, setMissing] = createSignal(false);
    const buffer = { path, session, dirty, conflict, missing, scroll: undefined };
    const entry: Entry = {
      buffer,
      version,
      disk: text,
      persisted: session.getSnapshot(),
      inflight: undefined,
      saving: 0,
      unconfirmed: false,
      applying: false,
      setDirty,
      setConflict,
      setMissing,
      unsubscribe: () => {},
    };
    entry.unsubscribe = session.buffer.subscribe(() => {
      if (!entry.applying) entry.version = nextVersion();
      refreshDirty(entry);
      if (!entry.applying) options.onChange?.(entry.buffer.path);
    });
    return entry;
  }

  /** Puts `text` in the buffer as one undoable edit made by us, not by the person typing. */
  function replaceText(entry: Entry, text: string): void {
    const edit = replacementBetween(entry.buffer.session.materializeFullText(), text);
    entry.applying = true;
    try {
      if (edit) entry.buffer.session.applyEdits([edit], { origin: "external" });
    } finally {
      entry.applying = false;
    }
  }

  /** Takes the disk text as the buffer's clean state. */
  function adopt(entry: Entry, text: string | undefined): void {
    replaceText(entry, text ?? "");
    entry.version = nextVersion();
    entry.persisted = entry.buffer.session.getSnapshot();
    entry.disk = text;
    entry.unconfirmed = false;
    entry.setConflict(undefined);
    entry.setMissing(text === undefined);
    refreshDirty(entry);
  }

  /** The entry still is the open buffer for its path: nothing closed or moved it meanwhile. */
  const live = (entry: Entry) => entries.get(entry.buffer.path) === entry;

  async function syncOne(entry: Entry): Promise<void> {
    if (entry.saving > 0) return;
    const path = entry.buffer.path;
    // A detached draft has no file to compare with.
    if (isDetached(path)) return;
    const text = await files.read(path);
    // The buffer may have been closed, moved or saved while the read ran; a moved buffer is
    // compared again under its new path by the sync that follows the move.
    if (!live(entry) || entry.buffer.path !== path || entry.saving > 0) return;
    // Back to what the buffer was last in step with: an earlier outside change was undone.
    if (text === entry.disk) {
      entry.setMissing(text === undefined);
      return entry.setConflict(undefined);
    }
    // Storage moved away from a save it never confirmed: the save may be lost, so the buffer's
    // text stays, unsaved, instead of being replaced by what storage came back with. Only a buffer
    // in step with that save holds it; a buffer opened on later text at the path does not.
    const pending = undurable.get(path);
    if (pending && holds(entry, pending)) setUnconfirmed(entry, true);
    if (text === undefined) return markGone(entry);
    entry.setMissing(false);
    const current = entry.buffer.session.materializeFullText();
    if (text === current || !entry.buffer.dirty()) return adopt(entry, text);
    entry.setConflict({ diskText: text });
  }

  function detachBuffer(entry: Entry, target: string, buffer: boolean): Displacement {
    let aside = detachedKey(target);
    while (entries.has(aside)) aside = detachedKey(target);
    entry.buffer.path = aside;
    entry.version = nextVersion();
    markGone(entry);
    entry.setDirty(true);
    entries.set(aside, entry);
    return { from: target, to: aside, buffer };
  }

  /**
   * The buffer holds the pending write: it wrote it, or was opened on it, so its text is that write
   * or edits made on top of it. A buffer marked unconfirmed already took the write over (its file
   * may since be gone). A buffer opened on text that replaced the write does not hold it.
   */
  const holds = (entry: Entry, pending: UndurableRecord) =>
    entry.unconfirmed || entry.disk === pending.draft.text;

  /**
   * What gives way at one replaced path. A pending write no open buffer holds is set aside on its
   * own. An unsaved buffer, or one holding the pending write, moves aside with its tab. A clean
   * buffer is let go only when a moving buffer takes the path; otherwise it stays open there (the
   * editor may be showing it) and the sync after the move loads the new file into it.
   */
  function displaceTarget(target: string, arriving: boolean): Displacement[] {
    const occupant = entries.get(target);
    const pending = undurable.get(target);
    undurable.delete(target);
    const held = occupant !== undefined && pending !== undefined && holds(occupant, pending);
    const displaced: Displacement[] = [];
    if (pending && !held) displaced.push(detachBuffer(create(target, pending.draft.text), target, false));
    if (!occupant) return displaced;
    if (occupant.buffer.dirty() || held) {
      entries.delete(target);
      displaced.push(detachBuffer(occupant, target, true));
      return displaced;
    }
    if (!arriving) return displaced;
    entries.delete(target);
    occupant.unsubscribe();
    return displaced;
  }

  /**
   * Before buffers move onto paths, any buffer or pending undurable write already at a destination
   * gives way (see `displaceTarget`), so no draft and no unflushed write is dropped.
   */
  function makeRoom(from: string, to: string, arriving: ReadonlySet<string>): Displacement[] {
    const replaced = (path: string) => isSameOrInside(path, to) && !isSameOrInside(path, from);
    const targets = new Set<string>();
    for (const path of entries.keys()) if (replaced(path)) targets.add(path);
    for (const path of undurable.keys()) if (replaced(path)) targets.add(path);
    return Array.from(targets).flatMap((target) => displaceTarget(target, arriving.has(target)));
  }

  /** A deleted file stays open, marked, with any unsaved text; saving writes it again. */
  function markGone(entry: Entry): void {
    entry.disk = undefined;
    entry.setMissing(true);
    entry.setConflict(undefined);
  }

  async function syncAll(): Promise<void> {
    do {
      syncAgain = false;
      // oxlint-disable-next-line no-await-in-loop -- a later round sees the changes of the earlier one
      await Promise.all(Array.from(entries.values(), (entry) => syncOne(entry).catch(() => {})));
    } while (syncAgain);
    syncing = undefined;
  }

  function applyRecoveredDraft(
    entry: Entry,
    draft: Draft,
    text: string | undefined,
    detached: boolean,
  ): void {
    replaceText(entry, draft.text);
    if (detached) {
      markGone(entry);
      entry.setDirty(isUnsaved(entry));
      return;
    }
    // The draft was made against `baseText`; a disk that moved on since is a conflict.
    entry.disk = draft.baseText;
    if (draft.baseText !== text) entry.setConflict({ diskText: text });
    entry.setDirty(isUnsaved(entry));
  }

  async function read(path: string): Promise<Buffer | undefined> {
    const detached = isDetached(path);
    // A write from before the file was closed may still be on its way: read what it leaves.
    if (!detached) await writesSettled(path);
    // Detached keys start with NUL and have no file on disk: load them from recovery only.
    const text = detached ? undefined : await files.read(path);
    const version = nextVersion();
    const draft = await options.recover?.(path, version);
    // Two opens of one file share the first buffer.
    const existing = entries.get(path);
    if (existing) return existing.buffer;
    if (text === undefined && !draft) return undefined;
    const entry = create(path, text, version);
    if (draft) applyRecoveredDraft(entry, draft, text, detached);
    entries.set(path, entry);
    membershipChanged();
    return entry.buffer;
  }

  /**
   * Writes acknowledged from memory but not yet flushed, by path, with what storage held before
   * the first of them. Owned independently of any open buffer so closing, reopening, or moving
   * never loses track of unflushed bytes.
   */
  interface UndurableRecord {
    path: string;
    readonly draft: Draft;
    readonly version: number;
  }
  const undurable = new Map<string, UndurableRecord>();

  function renameUndurable(from: string, to: string): void {
    const moved = Array.from(undurable.entries()).filter(([path]) => renamedPath(path, from, to) !== path);
    for (const [path] of moved) undurable.delete(path);
    for (const [path, record] of moved) {
      record.path = renamedPath(path, from, to);
      undurable.set(record.path, record);
    }
  }

  function setUnconfirmed(entry: Entry, unconfirmed: boolean): void {
    entry.unconfirmed = unconfirmed;
    refreshDirty(entry);
  }

  async function untilDurable(path: string, written: Draft, version: number): Promise<void> {
    const record: UndurableRecord = {
      path,
      draft: { text: written.text, baseText: undurable.get(path)?.draft.baseText ?? written.baseText },
      version,
    };
    undurable.set(path, record);
    const durable = await files.saved().then(
      () => true,
      () => false,
    );
    // A later save or displacement may have replaced or evicted the record; it settles itself.
    if (undurable.get(record.path) !== record) return;
    const currentPath = record.path;
    // A filesystem flush can never make a detached draft durable.
    if (isDetached(currentPath)) return;
    const entry = entries.get(currentPath);
    // The flush failed: the text stays recoverable, and its buffer unsaved.
    if (!durable) {
      if (entry && entry.disk === written.text) setUnconfirmed(entry, true);
      return;
    }
    undurable.delete(currentPath);
    if (entry && entry.disk === written.text) setUnconfirmed(entry, false);
    options.onDurable?.(currentPath, record.version);
  }

  /** One save, run when the file's earlier saves have finished: it captures its text and baseline now. */
  interface Lock {
    readonly roots: readonly string[];
    readonly released: Promise<void>;
  }
  const locks = new Set<Lock>();
  /** Writes running now, by the path they write. */
  const writing = new Set<{ readonly path: string; readonly done: Promise<unknown> }>();

  /** Waits until no lock covers the buffer's path; the path may change (a move) while waiting. */
  async function untilUnlocked(entry: Entry): Promise<void> {
    for (;;) {
      const blocking = Array.from(locks).filter((held) => under(entry.buffer.path, held.roots));
      if (blocking.length === 0) return;
      // oxlint-disable-next-line no-await-in-loop -- a lock released may reveal another on the new path
      await Promise.all(blocking.map((held) => held.released));
    }
  }

  async function lock(roots: readonly string[]): Promise<PathLock> {
    const gate = Promise.withResolvers<void>();
    const record: Lock = { roots, released: gate.promise };
    locks.add(record);
    const running = Array.from(writing).filter((write) => under(write.path, roots));
    await Promise.all(running.map((write) => write.done.catch(() => {})));
    return {
      release() {
        locks.delete(record);
        gate.resolve();
      },
    };
  }

  const lockedFor = (entry: Entry) => Array.from(locks).some((held) => under(entry.buffer.path, held.roots));

  /**
   * Saves serialize along two axes: by stable buffer identity (so a rename between two saves of
   * the same buffer never lets them overlap with the same baseline) and by final write path (so
   * distinct or closed-then-reopened buffers writing the same path never overlap either).
   */
  interface Queue {
    tail: Promise<void>;
    count: number;
  }
  const entryQueues = new Map<Entry, Queue>();
  const pathQueues = new Map<string, Queue>();

  function enqueueIn<K, T>(queues: Map<K, Queue>, key: K, run: () => Promise<T>): Promise<T> {
    const queue = queues.get(key) ?? { tail: Promise.resolve(), count: 0 };
    // With nothing queued the work starts at once, so a save captures the text as it is right now.
    const started = queue.count === 0 ? run() : queue.tail.then(run);
    queue.count += 1;
    queues.set(key, queue);
    const done = started.finally(() => {
      queue.count -= 1;
      if (queue.count === 0 && queues.get(key) === queue) queues.delete(key);
    });
    queue.tail = done.then(
      () => undefined,
      () => undefined,
    );
    return done;
  }

  /** Resolves once every write already queued for `path` has settled. */
  const writesSettled = (path: string) => pathQueues.get(path)?.tail ?? Promise.resolve();

  async function writeOnPath(entry: Entry, target: string, when: SaveOptions["when"]): Promise<boolean> {
    if (!live(entry) || isDetached(entry.buffer.path)) return true;
    // The buffer moved or became locked while waiting in the path queue: re-enter for the new state.
    if (entry.buffer.path !== target || lockedFor(entry)) return false;
    if (when && !when(entry.buffer)) return true;
    // Nothing awaits between here and the write starting: a lock taken now sees this write.
    const version = entry.version;
    const snapshot = entry.buffer.session.getSnapshot();
    const text = entry.buffer.session.materializeFullText();
    entry.saving += 1;
    entry.inflight = snapshot;
    refreshDirty(entry);
    try {
      const write = files.writeIfUnchanged(target, text, entry.disk);
      const record = { path: target, done: write };
      writing.add(record);
      const outcome = await write.finally(() => writing.delete(record));
      if (outcome.written) void untilDurable(target, { text, baseText: entry.disk }, version);
      // The file moved while the write ran: what was written went to the old path, so it says
      // nothing about this buffer's file. The buffer stays unsaved.
      if (entry.buffer.path !== target) return true;
      if (outcome.written) {
        entry.persisted = snapshot;
        entry.disk = text;
        entry.setConflict(undefined);
        entry.setMissing(false);
      } else {
        entry.setConflict({ diskText: outcome.current });
      }
      return true;
    } finally {
      // Whatever the outcome, including a write that threw, dirty is worked out again.
      entry.saving -= 1;
      entry.inflight = undefined;
      refreshDirty(entry);
    }
  }

  async function saveEntry(entry: Entry, when: SaveOptions["when"]): Promise<void> {
    for (;;) {
      // Only a locked path waits: otherwise the save captures the text exactly when it was asked for.
      // oxlint-disable-next-line no-await-in-loop -- a lock may appear while waiting in the path queue
      if (lockedFor(entry)) await untilUnlocked(entry);
      if (!live(entry) || isDetached(entry.buffer.path)) return;
      const target = entry.buffer.path;
      // oxlint-disable-next-line no-await-in-loop -- retries only if the buffer moved or locked while waiting
      const handled = await enqueueIn(pathQueues, target, () => writeOnPath(entry, target, when));
      if (handled) return;
    }
  }

  function save(path: string, saveOptions: SaveOptions = {}): Promise<void> {
    const entry = entries.get(path);
    if (!entry) return Promise.resolve();
    return enqueueIn(entryQueues, entry, () => saveEntry(entry, saveOptions.when));
  }

  function unsavedSnapshot(): UnsavedSnapshot {
    // Saves storage does not hold yet first; a buffer's newer unsaved text replaces its entry.
    const drafts = new Map<string, Draft>();
    const versions = new Map<string, number>();
    for (const [path, record] of undurable) {
      drafts.set(path, record.draft);
      versions.set(path, record.version);
    }
    for (const entry of entries.values()) {
      if (!entry.buffer.dirty()) continue;
      const path = entry.buffer.path;
      const text = entry.buffer.session.materializeFullText();
      drafts.set(path, {
        text,
        baseText: undurable.get(path)?.draft.baseText ?? entry.disk,
      });
      versions.set(path, entry.version);
    }
    return { drafts, versions };
  }

  return {
    dirtyPaths,
    save,
    get(path) {
      generation();
      return entries.get(path)?.buffer;
    },
    load(path) {
      const existing = entries.get(path);
      if (existing) return Promise.resolve(existing.buffer);
      const pending = loading.get(path) ?? read(path).finally(() => loading.delete(path));
      loading.set(path, pending);
      return pending;
    },
    release(path) {
      const entry = entries.get(path);
      if (!entry) return;
      entry.unsubscribe();
      entries.delete(path);
      membershipChanged();
    },
    markRemoved(paths) {
      for (const entry of entries.values()) {
        if (paths.some((path) => isSameOrInside(entry.buffer.path, path))) markGone(entry);
      }
    },
    rename(from, to) {
      const moved = Array.from(entries.values()).filter(
        (entry) => renamedPath(entry.buffer.path, from, to) !== entry.buffer.path,
      );
      const arriving = new Set(moved.map((entry) => renamedPath(entry.buffer.path, from, to)));
      const displaced = makeRoom(from, to, arriving);
      renameUndurable(from, to);
      for (const entry of moved) entries.delete(entry.buffer.path);
      for (const entry of moved) {
        entry.buffer.path = renamedPath(entry.buffer.path, from, to);
        entries.set(entry.buffer.path, entry);
      }
      if (moved.length > 0 || displaced.length > 0) membershipChanged();
      return displaced;
    },
    lock,
    sync() {
      if (syncing) {
        syncAgain = true;
        return syncing;
      }
      syncing = syncAll();
      return syncing;
    },
    // Both choices read the file again: the version the conflict was raised for may be gone.
    async keepMine(path) {
      const entry = entries.get(path);
      if (!entry?.buffer.conflict()) return;
      const text = await files.read(entry.buffer.path);
      if (!live(entry)) return;
      entry.version = nextVersion();
      entry.disk = text;
      entry.setMissing(text === undefined);
      entry.setConflict(undefined);
    },
    async takeTheirs(path) {
      const entry = entries.get(path);
      if (!entry?.buffer.conflict()) return;
      const text = await files.read(entry.buffer.path);
      if (!live(entry)) return;
      // The person chose the file over this tab's text, an unconfirmed save of it included.
      undurable.delete(entry.buffer.path);
      if (text !== undefined) return adopt(entry, text);
      // The file is gone: there is nothing to reload, so the draft stays, marked deleted.
      markGone(entry);
    },
    paths: () => Array.from(entries.keys()),
    unsaved: () => unsavedSnapshot().drafts,
    unsavedSnapshot,
    dispose() {
      for (const entry of entries.values()) entry.unsubscribe();
      entries.clear();
    },
  };
}
