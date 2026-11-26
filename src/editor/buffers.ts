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
   */
  save(path: string): Promise<void>;
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
  readonly dirtyPaths: Accessor<readonly string[]>;
  dispose(): void;
}

interface Entry {
  buffer: Buffer & { path: string };
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
  /** Unsaved text another tab left behind for a file, applied when the file is opened. */
  readonly recover?: (path: string) => Draft | undefined;
  /** A file's saved text has reached storage: a copy left for recovery is no longer needed. */
  readonly onDurable?: (path: string) => void;
}

export function createBufferSet(files: Files, options: BufferSetOptions = {}): BufferSet {
  const entries = new Map<string, Entry>();
  const loading = new Map<string, Promise<Buffer | undefined>>();
  const [dirtyPaths, setDirtyPaths] = createSignal<readonly string[]>([]);
  // Moves whenever buffers come, go or move, so `get` can be read reactively.
  const [generation, setGeneration] = createSignal(0);
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
    if (entry.unconfirmed) return true;
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

  function create(path: string, text: string | undefined): Entry {
    const session = createEditorBufferSession(createEditorTextBuffer(text ?? ""));
    const [dirty, setDirty] = createSignal(false);
    const [conflict, setConflict] = createSignal<Conflict>();
    const [missing, setMissing] = createSignal(false);
    const buffer = { path, session, dirty, conflict, missing, scroll: undefined };
    const entry: Entry = {
      buffer,
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
    entry.unsubscribe = session.buffer.subscribe(() => refreshDirty(entry));
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
    // text stays, unsaved, instead of being replaced by what storage came back with.
    if (undurable.has(path)) setUnconfirmed(entry, true);
    if (text === undefined) return markGone(entry);
    entry.setMissing(false);
    const current = entry.buffer.session.materializeFullText();
    if (text === current || !entry.buffer.dirty()) return adopt(entry, text);
    entry.setConflict({ diskText: text });
  }

  /**
   * Before buffers move onto paths, a buffer already at one of those paths gives way: a clean
   * one is let go (its file was replaced), one with unsaved text is detached (a key no file can
   * open at) and marked deleted, so no draft is dropped. Returns where the drafts went.
   */
  function makeRoom(moving: readonly Entry[], from: string, to: string): Displacement[] {
    const movingSet = new Set(moving);
    const displaced: Displacement[] = [];
    for (const entry of moving) {
      const target = renamedPath(entry.buffer.path, from, to);
      const occupant = entries.get(target);
      if (!occupant || movingSet.has(occupant)) continue;
      entries.delete(target);
      if (!occupant.buffer.dirty()) {
        occupant.unsubscribe();
        continue;
      }
      occupant.buffer.path = detachedKey(target);
      markGone(occupant);
      entries.set(occupant.buffer.path, occupant);
      displaced.push({ from: target, to: occupant.buffer.path });
    }
    return displaced;
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

  async function read(path: string): Promise<Buffer | undefined> {
    // A write from before the file was closed may still be on its way: read what it leaves.
    await writesSettled(path);
    const text = await files.read(path);
    // Two opens of one file share the first buffer.
    const existing = entries.get(path);
    if (existing) return existing.buffer;
    const draft = options.recover?.(path);
    if (text === undefined && !draft) return undefined;
    const entry = create(path, text);
    if (draft) {
      replaceText(entry, draft.text);
      // The draft was made against `baseText`; a disk that moved on since is a conflict.
      entry.disk = draft.baseText;
      if (draft.baseText !== text) entry.setConflict({ diskText: text });
      refreshDirty(entry);
    }
    entries.set(path, entry);
    membershipChanged();
    return entry.buffer;
  }

  /**
   * Writes acknowledged from memory but not yet flushed, by path, with what storage held before
   * the first of them. They are recoverable text until the flush is done, even if the tab closed.
   */
  const undurable = new Map<string, Draft>();

  function setUnconfirmed(entry: Entry, unconfirmed: boolean): void {
    entry.unconfirmed = unconfirmed;
    refreshDirty(entry);
  }

  async function untilDurable(path: string, written: Draft): Promise<void> {
    const draft = { text: written.text, baseText: undurable.get(path)?.baseText ?? written.baseText };
    undurable.set(path, draft);
    const durable = await files.saved().then(
      () => true,
      () => false,
    );
    // A later save of the same path may have replaced the record; it settles itself.
    if (undurable.get(path) !== draft) return;
    const entry = entries.get(path);
    // The flush failed: the text stays recoverable, and its buffer unsaved.
    if (!durable) {
      if (entry && entry.disk === written.text) setUnconfirmed(entry, true);
      return;
    }
    undurable.delete(path);
    if (entry && entry.disk === written.text) setUnconfirmed(entry, false);
    options.onDurable?.(path);
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

  async function saveNow(entry: Entry): Promise<void> {
    // Only a locked path waits: otherwise the save captures the text exactly when it was asked for.
    if (lockedFor(entry)) await untilUnlocked(entry);
    // Nothing awaits between here and the write starting: a lock taken now sees this write.
    if (!live(entry) || isDetached(entry.buffer.path)) return;
    const target = entry.buffer.path;
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
      if (outcome.written) void untilDurable(target, { text, baseText: entry.disk });
      // The file moved while the write ran: what was written went to the old path, so it says
      // nothing about this buffer's file. The buffer stays unsaved.
      if (entry.buffer.path !== target) return;
      if (outcome.written) {
        entry.persisted = snapshot;
        entry.disk = text;
        entry.setConflict(undefined);
        entry.setMissing(false);
      } else {
        entry.setConflict({ diskText: outcome.current });
      }
    } finally {
      // Whatever the outcome, including a write that threw, dirty is worked out again.
      entry.saving -= 1;
      entry.inflight = undefined;
      refreshDirty(entry);
    }
  }

  /**
   * Writes to one path run one after another, per path rather than per buffer: closing and
   * reopening a file while its write is pending must not start a second, overlapping line.
   */
  const pathQueues = new Map<string, { tail: Promise<void>; count: number }>();

  function enqueue(path: string, run: () => Promise<void>): Promise<void> {
    const queue = pathQueues.get(path) ?? { tail: Promise.resolve(), count: 0 };
    // With nothing queued the save starts at once, so it captures the text as it is right now.
    const started = queue.count === 0 ? run() : queue.tail.then(run);
    queue.count += 1;
    pathQueues.set(path, queue);
    const done = started.finally(() => {
      queue.count -= 1;
      if (queue.count === 0 && pathQueues.get(path) === queue) pathQueues.delete(path);
    });
    queue.tail = done.catch(() => {});
    return done;
  }

  /** Resolves once every write already queued for `path` has settled. */
  const writesSettled = (path: string) => pathQueues.get(path)?.tail ?? Promise.resolve();

  function save(path: string): Promise<void> {
    const entry = entries.get(path);
    if (!entry) return Promise.resolve();
    return enqueue(path, () => saveNow(entry));
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
      const displaced = makeRoom(moved, from, to);
      for (const entry of moved) entries.delete(entry.buffer.path);
      for (const entry of moved) {
        entry.buffer.path = renamedPath(entry.buffer.path, from, to);
        entries.set(entry.buffer.path, entry);
      }
      membershipChanged();
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
    unsaved() {
      // Saves storage does not hold yet first; a buffer's newer unsaved text replaces its entry.
      const all = new Map(undurable);
      for (const entry of entries.values()) {
        if (!entry.buffer.dirty()) continue;
        const text = entry.buffer.session.materializeFullText();
        all.set(entry.buffer.path, {
          text,
          baseText: undurable.get(entry.buffer.path)?.baseText ?? entry.disk,
        });
      }
      return all;
    },
    dispose() {
      for (const entry of entries.values()) entry.unsubscribe();
      entries.clear();
    },
  };
}
