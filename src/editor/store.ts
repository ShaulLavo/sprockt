// The editor's state for one workspace: open tabs, the active tab, file buffers, where to reveal,
// and whether quick open or project search is showing. Other panes (the explorer, the title bar)
// drive the editor only through this store.
import { createEffect, createSignal, on, onCleanup, type Accessor } from "../lib/reactive";
import type { FileChange, FileService } from "../files/service";
import { createAutosave, loadAutosaveSetting, storeAutosaveSetting } from "./autosave";
import { createBufferSet, freeName, isDetached, originalPath, type Buffer, type BufferSet } from "./buffers";
import { EDITOR_COPY } from "./copy";
import { loadTabs, saveTabs } from "./persist";
import { createDraftKeeper } from "./recovery";
import { closeTab, moveTab, openTab, pinTab, renamedPath, renameTabs, type EditorTab } from "./tabs";

export type { EditorTab } from "./tabs";

export interface OpenOptions {
  /** Open as a preview tab, replaced by the next preview until it is edited or pinned. */
  readonly preview?: boolean;
  /** 1-based line to reveal and put the caret on. */
  readonly line?: number;
  /** 1-based column on that line. */
  readonly column?: number;
  /** Move keyboard focus into the editor once the file shows (implied by `line`). */
  readonly focus?: boolean;
}

/** A request to focus the editor, at a line when given; `seq` makes a repeat a new request. */
export interface RevealRequest {
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
  readonly seq: number;
}

/** The file on screen changed on disk under unsaved edits, or a save found it changed. */
export interface Conflict {
  readonly path: string;
  /** What the file holds now; undefined when it was deleted. */
  readonly diskText: string | undefined;
}

/** Confirmation dialog state for a staged batch of tabs awaiting close. */
export interface PendingClose {
  readonly paths: readonly string[];
  readonly saving: boolean;
  readonly error: string | undefined;
}

export interface MoveLock {
  /** `moved`: the move happened, so saves wait for its change event as well. */
  release(moved: boolean): void;
}

export interface EditorStore {
  readonly tabs: Accessor<readonly EditorTab[]>;
  /** The selected tab. */
  readonly active: Accessor<string | undefined>;
  /** The file on screen. It trails `active` while the selected file is being read. */
  readonly displayed: Accessor<string | undefined>;
  /** Whether the file on screen has unsaved edits. */
  readonly dirty: Accessor<boolean>;
  /** Set while the file on screen has a conflict; cleared when the person chose a version. */
  readonly conflict: Accessor<Conflict | undefined>;
  /** Whether `path` has unsaved edits, on screen or in a background tab. */
  hasUnsaved(path: string): boolean;
  readonly buffers: BufferSet;
  readonly reveal: Accessor<RevealRequest | undefined>;
  open(path: string, options?: OpenOptions): void;
  /** Closes a tab without asking; callers confirm unsaved changes first. */
  close(path: string): void;
  move(from: number, to: number): void;
  pin(path: string): void;
  /**
   * Locks paths for a move (the explorer's rename or drag): waits for saves writing there, and
   * holds new saves until `release`. Released after a successful move, saves wait further until
   * the change event reporting the move was applied, so they write to the new path.
   */
  lockPaths(roots: readonly string[]): Promise<MoveLock>;
  /** Saves the file on screen, or `path` when given. Never the file merely selected. */
  save(path?: string): Promise<void>;
  /** Saves every file with unsaved edits. A conflict stays a conflict. */
  saveAll(): Promise<void>;
  /** Whether autosave is on (the person's setting, kept in this browser). */
  readonly autosave: Accessor<boolean>;
  setAutosave(enabled: boolean): void;
  /** Autosaves now rather than after the idle wait: the page was hidden or the editor lost focus. */
  flushAutosave(): Promise<void>;
  /**
   * The page was hidden or is going away: every unsaved text is left for recovery first (so the
   * save below is never its only copy), then autosaved. The copy goes once the text is durable.
   */
  pageHidden(): Promise<void>;
  /** Keeps the edits of the file on screen over the disk version, and saves them. */
  keepMine(): Promise<void>;
  /** Replaces the edits of the file on screen with what the file holds now. */
  takeTheirs(): Promise<void>;
  /** Lets go of buffers whose tab is gone; the editor view calls it after a late load. */
  releaseClosed(): void;
  /** Set by the editor view when it shows a file; nothing else calls it. */
  setDisplayed(path: string | undefined): void;
  readonly quickOpen: Accessor<boolean>;
  readonly quickOpenSeed: Accessor<string>;
  setQuickOpen(open: boolean, seed?: string): void;
  readonly searchOpen: Accessor<boolean>;
  setSearchOpen(open: boolean): void;
  /** Bumped to ask the search panel to focus its query field. */
  readonly searchFocus: Accessor<number>;
  /** Tabs awaiting save/discard confirmation before closing. */
  readonly pendingClose: Accessor<PendingClose | undefined>;
  requestClose(paths: readonly string[]): void;
  resolvePendingClose(action: "save" | "discard" | "cancel"): Promise<void>;
}

export interface EditorWorkspace {
  readonly id: string;
  readonly files: Pick<
    FileService,
    "read" | "writeIfUnchanged" | "saved" | "revision" | "writable" | "subscribe"
  >;
}

/** Call inside a component: the store follows the files for as long as its owner lives. */
export function createEditorStore(workspace: EditorWorkspace): EditorStore {
  const saved = loadTabs(workspace.id);
  const [tabs, setTabs] = createSignal<readonly EditorTab[]>(saved.tabs);
  const [active, setActive] = createSignal<string | undefined>(saved.active);
  const [displayed, setDisplayed] = createSignal<string>();
  const [reveal, setReveal] = createSignal<RevealRequest>();
  const [quickOpen, setQuickOpenFlag] = createSignal(false);
  const [quickOpenSeed, setQuickOpenSeed] = createSignal("");
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [searchFocus, setSearchFocus] = createSignal(0);
  interface CloseTarget {
    readonly initialPath: string;
    readonly buffer: Buffer | undefined;
    readonly dirty: boolean;
  }
  interface StagedClose {
    readonly targets: readonly CloseTarget[];
    readonly saving: boolean;
    readonly error: string | undefined;
  }
  const [stagedClose, setStagedClose] = createSignal<StagedClose>();
  let revealSeq = 0;

  function setQuickOpen(open: boolean, seed = ""): void {
    setQuickOpenSeed(open ? seed : "");
    setQuickOpenFlag(open);
  }

  function commit(nextTabs: readonly EditorTab[], nextActive: string | undefined): void {
    setTabs(nextTabs);
    setActive(nextActive);
    saveTabs(workspace.id, { tabs: nextTabs, active: nextActive });
  }

  /** Lets go of buffers whose tab is gone (a replaced preview, a load that finished too late). */
  /**
   * Lets go of buffers whose tab is gone (a replaced preview, a load that finished too late). The
   * buffer on screen is kept until the editor shows another one: it can still be typed in.
   */
  function releaseClosed(): void {
    const keep = new Set(tabs().map((tab) => tab.path));
    const shown = displayed();
    if (shown !== undefined) keep.add(shown);
    for (const path of buffers.paths()) if (!keep.has(path)) buffers.release(path);
  }

  const pin = (path: string) => commit(pinTab(tabs(), path), active());

  /** An edit pins a preview; an edit to a file whose preview was just replaced brings its tab back. */
  function edited(path: string): void {
    if (tabs().some((tab) => tab.path === path)) return pin(path);
    commit(tabs().concat([{ path, preview: false }]), active());
  }

  const [autosaveOn, setAutosaveOn] = createSignal(loadAutosaveSetting(localStorage));
  const autosave = createAutosave({
    buffers: {
      paths: () => buffers.paths(),
      get: (path) => buffers.get(path),
      save: (path, options) => buffers.save(path, options),
    },
    enabled: autosaveOn,
    writable: workspace.files.writable,
    isDetached,
    onError: (error) => console.error("Saving failed", error),
  });

  const drafts = createDraftKeeper({
    storage: localStorage,
    workspace: workspace.id,
    tab: crypto.randomUUID(),
    locks: typeof navigator === "undefined" ? undefined : navigator.locks,
    renamedPath,
  });

  const buffers = createBufferSet(workspace.files, {
    onEdit: edited,
    onChange: () => autosave.edited(),
    // A copy a gone tab left stays until a flush covering that version is durable.
    recover: (path, version) => drafts.recover(path, version),
    onDurable: (path, version) => drafts.settled(path, version),
  });

  function leaveUnsaved(): void {
    const snapshot = buffers.unsavedSnapshot();
    drafts.leave(snapshot.drafts, snapshot.versions);
  }

  const shownBuffer = () => {
    const path = displayed();
    return path === undefined ? undefined : buffers.get(path);
  };
  const save = async (path = displayed()) => {
    if (path === undefined) return;
    // Exclusive creation still turns a name taken in the meantime into a conflict.
    await buffers.save(isDetached(path) ? await attach(path) : path);
  };

  /** Moves a single tab, the file on screen and the selection from one exact path to another. */
  function retarget(from: string, to: string, current: string | undefined): string | undefined {
    const list = tabs();
    const nextTabs = list.some((tab) => tab.path === from)
      ? list.map((tab) => (tab.path === from ? { path: to, preview: false } : tab))
      : list.concat([{ path: to, preview: false }]);
    commit(nextTabs, current === from ? to : current);
    if (displayed() === from) setDisplayed(to);
    return current === from ? to : current;
  }

  /**
   * Tabs, the file on screen and buffers (with unsaved text and undo) follow a move. A draft or
   * pending undurable write at a destination is not dropped: it moves aside to a free name first.
   */
  function applyRename(from: string, to: string): void {
    const follows = (path: string) => renamedPath(path, from, to) !== path;
    const shown = displayed();
    const displaced = buffers.rename(from, to);
    const affected =
      displaced.length > 0 ||
      tabs().some((tab) => follows(tab.path)) ||
      (shown !== undefined && follows(shown));
    if (!affected) {
      drafts.renamed(from, to);
      return;
    }
    let current = active();
    for (const aside of displaced) {
      // Drafts recovered from other tabs go with the oldest text set aside that covers them
      // (displacements come oldest first), so that text's durable save clears them.
      drafts.handedOver(aside.from, aside.to, aside.version);
      if (aside.buffer) current = retarget(aside.from, aside.to, current);
      else commit(tabs().concat([{ path: aside.to, preview: false }]), current);
    }
    drafts.renamed(from, to);
    const moved = displayed();
    commit(renameTabs(tabs(), from, to), current === undefined ? undefined : renamedPath(current, from, to));
    if (moved !== undefined) setDisplayed(renamedPath(moved, from, to));
    // One path can split into two detached drafts (a pending write and newer edits), and this
    // tab's single recovery copy at that path belongs to only one of them. A fresh snapshot gives
    // each its own copy, with its own version, before anything can settle the wrong one.
    if (displaced.length > 0) leaveUnsaved();
  }

  /** The last move operation applied; FileService numbers them in the order they happened. */
  let lastOperation = 0;
  /** Locks waiting for the change event that reports their move before they let saves through. */
  let afterNextChange: (() => void)[] = [];

  /**
   * Moves come from FileService change events only, applied once each and in order: the first
   * entry of an operation is the file or folder that moved, the entries after it with the same
   * operation list the files inside it and are covered by applying the first. Applying a move only
   * changes which path a buffer points at; nothing is written. The revision sync that follows
   * compares each moved buffer with its new file, so different disk text under unsaved edits
   * shows as a conflict.
   */
  function applyChange(change: FileChange): void {
    for (const move of change.moves) {
      if (move.operation <= lastOperation) continue;
      lastOperation = move.operation;
      applyRename(move.from, move.to);
    }
    if (change.removed.length > 0) buffers.markRemoved(change.removed);
    if (change.moves.length > 0) void buffers.sync();
    const waiting = afterNextChange;
    afterNextChange = [];
    for (const release of waiting) release();
  }

  // Resolves once this tab loses the workspace: a move waiting for saves then gives up.
  const revoked = Promise.withResolvers<void>();
  createEffect(() => {
    if (!workspace.files.writable()) revoked.resolve();
  });

  async function lockPaths(roots: readonly string[]): Promise<MoveLock> {
    const lock = await Promise.race([
      buffers.lock(roots),
      revoked.promise.then((): never => {
        throw new Error("This workspace is open in another tab, so this tab can no longer change files.");
      }),
    ]);
    return {
      release(moved) {
        // Saves wait until the editor has followed the move, so they write to the new path.
        if (moved) afterNextChange.push(() => lock.release());
        else lock.release();
      },
    };
  }

  /** A detached draft is saved under a free name next to where it was, picked now. */
  async function attach(key: string): Promise<string> {
    const original = originalPath(key);
    const known = new Set(
      tabs()
        .map((tab) => tab.path)
        .concat(buffers.paths()),
    );
    for (;;) {
      const candidate = freeName(original, (path) => known.has(path));
      // oxlint-disable-next-line no-await-in-loop -- names are tried one after another
      if ((await workspace.files.read(candidate)) === undefined) {
        applyRename(key, candidate);
        return candidate;
      }
      known.add(candidate);
    }
  }

  createEffect(on(workspace.files.revision, () => void buffers.sync(), { defer: true }));
  // Moves and deletes made through FileService (the explorer, another pane) say exactly what
  // happened, in order: a folder lists every file inside it. Changes by the shell or another tab
  // only arrive as changed paths, and the revision sync marks a vanished file deleted.
  onCleanup(workspace.files.subscribe(applyChange));
  // Once another tab owns the workspace this tab cannot save. Its unsaved text is left where
  // that tab finds it when it opens the file, and this tab no longer holds it.
  createEffect(() => {
    if (workspace.files.writable()) return;
    leaveUnsaved();
    drafts.release();
  });
  // Showing another file autosaves the one that was on screen (and any other pending edit).
  createEffect(on(displayed, () => void autosave.flush(), { defer: true }));
  // Detached drafts have no path in the file tree: if another attached tab last wrote the saved
  // tab list, surface any recoverable detached drafts from gone tabs as open tabs here.
  let disposed = false;
  async function discoverDetached(): Promise<void> {
    const detached = await drafts.recoverablePaths(isDetached);
    if (disposed || detached.length === 0) return;
    const openPaths = new Set(tabs().map((tab) => tab.path));
    const missing = detached.filter((path) => !openPaths.has(path));
    if (missing.length > 0) {
      commit(tabs().concat(missing.map((path) => ({ path, preview: false }))), active() ?? missing[0]);
    }
    const loaded = await Promise.all(
      detached.map(async (path) => ({ path, buffer: await buffers.load(path) })),
    );
    if (disposed) return;
    for (const item of loaded) {
      if (item.buffer) continue;
      const next = closeTab(tabs(), item.path, active());
      commit(next.tabs, next.active);
    }
  }
  void discoverDetached();
  onCleanup(() => {
    disposed = true;
    autosave.dispose();
    buffers.dispose();
    drafts.release();
  });

  async function saveAll(): Promise<void> {
    const saves = buffers.dirtyPaths().map((path) => save(path));
    const outcomes = await Promise.allSettled(saves);
    const failed = outcomes.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );
    if (failed) throw failed.reason;
  }

  function closeOne(path: string): void {
    const wasDirty = buffers.get(path)?.dirty() ?? false;
    const next = closeTab(tabs(), path, active());
    commit(next.tabs, next.active);
    buffers.release(path);
    // Closing a dirty tab confirmed dropping its unsaved edits. Closing a clean tab whose
    // save has not flushed yet keeps any recovery copy until that flush finishes.
    if (wasDirty || !buffers.unsaved().has(path)) drafts.settled(path);
  }

  function currentPathOf(target: CloseTarget): string | undefined {
    const buffer = target.buffer;
    if (buffer) return buffers.get(buffer.path) === buffer ? buffer.path : undefined;
    if (!tabs().some((tab) => tab.path === target.initialPath)) return undefined;
    return buffers.get(target.initialPath)?.dirty() ? undefined : target.initialPath;
  }

  function requestClose(paths: readonly string[]): void {
    if (paths.length === 0) return;
    const openSet = new Set(tabs().map((tab) => tab.path));
    const targets: CloseTarget[] = [];
    for (const path of new Set(paths)) {
      if (!openSet.has(path)) continue;
      const buffer = buffers.get(path);
      targets.push({ initialPath: path, buffer, dirty: buffer?.dirty() ?? false });
    }
    if (targets.length === 0) return;
    if (!targets.some((target) => target.dirty)) {
      for (const target of targets) closeOne(target.initialPath);
      return;
    }
    // Stage the full batch (clean + dirty) so Cancel leaves the entire tab set untouched.
    setStagedClose({ targets, saving: false, error: undefined });
  }

  async function saveAndCloseTarget(target: CloseTarget): Promise<string | undefined> {
    const buffer = target.buffer;
    if (!buffer) {
      const path = currentPathOf(target);
      if (path !== undefined) closeOne(path);
      return undefined;
    }
    if (buffers.get(buffer.path) !== buffer) return undefined;
    if (buffer.dirty()) {
      try {
        await save(buffer.path);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }
    // Re-check buffer identity after async save (saving a detached draft renames buffer.path in place).
    if (buffers.get(buffer.path) !== buffer) return undefined;
    if (buffer.dirty()) return EDITOR_COPY.externalChangeConflict;
    closeOne(buffer.path);
    return undefined;
  }

  async function resolvePendingClose(action: "save" | "discard" | "cancel"): Promise<void> {
    const staged = stagedClose();
    if (!staged || staged.saving) return;
    if (action === "cancel") {
      setStagedClose(undefined);
      return;
    }
    if (action === "discard") {
      setStagedClose(undefined);
      for (const target of staged.targets) {
        const path = currentPathOf(target);
        if (path !== undefined) closeOne(path);
      }
      return;
    }
    setStagedClose({ ...staged, saving: true, error: undefined });
    const remaining: CloseTarget[] = [];
    let firstError: string | undefined;
    for (const target of staged.targets) {
      // oxlint-disable-next-line no-await-in-loop -- save and close each confirmed target in order
      const error = await saveAndCloseTarget(target);
      if (error === undefined) continue;
      remaining.push(target);
      firstError ??= error;
    }
    setStagedClose(
      remaining.length > 0 ? { targets: remaining, saving: false, error: firstError } : undefined,
    );
  }

  function pendingClose(): PendingClose | undefined {
    const staged = stagedClose();
    if (!staged) return undefined;
    const dirtyPaths = staged.targets.flatMap((target) => {
      if (!target.dirty || !target.buffer) return [];
      return buffers.get(target.buffer.path) === target.buffer ? [target.buffer.path] : [];
    });
    const paths =
      dirtyPaths.length > 0
        ? dirtyPaths
        : staged.targets.map((target) => target.buffer?.path ?? target.initialPath);
    return { paths, saving: staged.saving, error: staged.error };
  }

  return {
    tabs,
    active,
    displayed,
    setDisplayed(path) {
      setDisplayed(path);
      releaseClosed();
    },
    buffers,
    reveal,
    quickOpen,
    quickOpenSeed,
    setQuickOpen,
    searchOpen,
    searchFocus,
    pendingClose,
    requestClose,
    resolvePendingClose,
    save,
    saveAll,
    autosave: autosaveOn,
    setAutosave(enabled) {
      setAutosaveOn(enabled);
      storeAutosaveSetting(localStorage, enabled);
      if (enabled) void autosave.flush();
    },
    flushAutosave: () => autosave.flush(),
    pageHidden() {
      // The page may never run again: the text goes to storage first, then the save is tried.
      leaveUnsaved();
      return autosave.flush();
    },
    setSearchOpen(open) {
      setSearchOpen(open);
      if (open) setSearchFocus((value) => value + 1);
    },
    dirty: () => shownBuffer()?.dirty() ?? false,
    conflict() {
      const buffer = shownBuffer();
      const conflict = buffer?.conflict();
      return buffer && conflict ? { path: buffer.path, diskText: conflict.diskText } : undefined;
    },
    hasUnsaved: (path) => buffers.dirtyPaths().includes(path),
    open(path, options = {}) {
      const preview = options.preview ?? false;
      // A preview with unsaved edits is never replaced: it becomes an ordinary tab first.
      const previous = tabs().find((tab) => tab.preview && tab.path !== path);
      if (preview && previous && buffers.dirtyPaths().includes(previous.path)) pin(previous.path);
      commit(openTab(tabs(), path, { preview, after: active() }), path);
      releaseClosed();
      if (options.line === undefined && !options.focus) return;
      revealSeq += 1;
      setReveal({ path, line: options.line, column: options.column, seq: revealSeq });
    },
    close: closeOne,
    move: (from, to) => commit(moveTab(tabs(), from, to), active()),
    pin,
    lockPaths,
    async keepMine() {
      const path = displayed();
      if (path === undefined) return;
      await buffers.keepMine(path);
      await save(path);
    },
    async takeTheirs() {
      const path = displayed();
      if (path === undefined) return;
      await buffers.takeTheirs(path);
      drafts.settled(path);
    },
    releaseClosed,
  };
}
