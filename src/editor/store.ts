// The editor's state for one workspace: open tabs, the active tab, file buffers, where to reveal,
// and whether quick open or project search is showing. Other panes (the explorer, the title bar)
// drive the editor only through this store.
import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js";
import type { FileService } from "../files/service";
import { createBufferSet, type BufferSet } from "./buffers";
import { loadTabs, saveTabs } from "./persist";
import { discardRecovered, leaveForRecovery, recovered } from "./recovery";
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
  /** Follows a file or directory the explorer moved. */
  rename(from: string, to: string): void;
  /** Saves the file on screen, or `path` when given. Never the file merely selected. */
  save(path?: string): Promise<void>;
  /** Keeps the edits of the file on screen over the disk version, and saves them. */
  keepMine(): Promise<void>;
  /** Replaces the edits of the file on screen with what the file holds now. */
  takeTheirs(): Promise<void>;
  /** Lets go of buffers whose tab is gone; the editor view calls it after a late load. */
  releaseClosed(): void;
  /** Set by the editor view when it shows a file; nothing else calls it. */
  setDisplayed(path: string | undefined): void;
  readonly quickOpen: Accessor<boolean>;
  setQuickOpen(open: boolean): void;
  readonly searchOpen: Accessor<boolean>;
  setSearchOpen(open: boolean): void;
  /** Bumped to ask the search panel to focus its query field. */
  readonly searchFocus: Accessor<number>;
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
  const [quickOpen, setQuickOpen] = createSignal(false);
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [searchFocus, setSearchFocus] = createSignal(0);
  let revealSeq = 0;

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

  const buffers = createBufferSet(workspace.files, {
    onEdit: edited,
    // A copy another tab left stays until this tab's text for the file is durable.
    recover: (path) => recovered(localStorage, workspace.id, path),
    onDurable: (path) => discardRecovered(localStorage, workspace.id, path),
  });
  const shownBuffer = () => {
    const path = displayed();
    return path === undefined ? undefined : buffers.get(path);
  };
  const save = async (path = displayed()) => {
    if (path !== undefined) await buffers.save(path);
  };

  /** Tabs, the file on screen and buffers (with unsaved text and undo) follow a move. */
  function rename(from: string, to: string): void {
    const follows = (path: string) => renamedPath(path, from, to) !== path;
    const shown = displayed();
    const affected = tabs().some((tab) => follows(tab.path)) || buffers.paths().some(follows);
    if (!affected && (shown === undefined || !follows(shown))) return;
    const current = active();
    commit(renameTabs(tabs(), from, to), current === undefined ? undefined : renamedPath(current, from, to));
    if (shown !== undefined) setDisplayed(renamedPath(shown, from, to));
    buffers.rename(from, to);
  }

  createEffect(on(workspace.files.revision, () => void buffers.sync(), { defer: true }));
  // Moves and deletes made through FileService (the explorer, another pane) say exactly what
  // happened: a folder lists every file inside it. Changes by the shell or another tab only
  // arrive as changed paths, and the revision sync marks a vanished file deleted.
  onCleanup(
    workspace.files.subscribe((change) => {
      for (const move of change.moves) rename(move.from, move.to);
      if (change.removed.length > 0) buffers.markRemoved(change.removed);
      if (change.moves.length > 0) void buffers.sync();
    }),
  );
  // Once another tab owns the workspace this tab cannot save. Its unsaved text is left where
  // that tab finds it when it opens the file.
  createEffect(() => {
    if (!workspace.files.writable()) leaveForRecovery(localStorage, workspace.id, buffers.unsaved());
  });
  onCleanup(() => buffers.dispose());

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
    setQuickOpen,
    searchOpen,
    searchFocus,
    save,
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
    close(path) {
      const next = closeTab(tabs(), path, active());
      commit(next.tabs, next.active);
      buffers.release(path);
      // Closing confirmed dropping any unsaved text, a recovered copy included.
      discardRecovered(localStorage, workspace.id, path);
    },
    move: (from, to) => commit(moveTab(tabs(), from, to), active()),
    pin,
    rename,
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
      discardRecovered(localStorage, workspace.id, path);
    },
    releaseClosed,
  };
}
