// The explorer's state and actions for one workspace: what is loaded, expanded, selected and being
// edited, and what happens when the user creates, renames, deletes, moves or uploads. The
// components only draw it and forward events.
import { createMemo, createSignal, onCleanup, type Accessor } from "../lib/reactive";
import { DestinationExistsError, FolderGoneError } from "../files/errors";
import { createAutoOpener } from "./auto-open";
import type { DirEntry, FileChange, FileService, UploadItem } from "../files/service";
import {
  ancestorsOf,
  baseName,
  checkName,
  isInside,
  isSameOrInside,
  joinPath,
  parentOf,
  rebase,
  type NameProblem,
} from "../files/paths";
import { copy, fill } from "./copy";
import {
  canMoveInto,
  entryRows,
  filterRows,
  navigate,
  rangeBetween,
  targetDirectory,
  topLevelPaths,
  visibleRows,
  type Draft,
  type Listings,
  type NavigationKey,
} from "./model";
import { downloadBlob } from "./download";

export interface ExplorerOptions {
  readonly files: FileService;
  readonly workspaceId: string;
  /** Opens a file in the editor. */
  open(path: string): void;
  /** The file open in the editor. */
  readonly active: Accessor<string | undefined>;
  /** Whether a file has edits the editor has not saved. Read reactively. */
  hasUnsaved(path: string): boolean;
  /** The paths of the files open in tabs. */
  openPaths(): readonly string[];
  /**
   * Locks paths in the editor for a move: resolves once its saves there have finished and holds
   * new ones until released. The editor follows the move itself, from FileService's change event.
   */
  lock(paths: readonly string[]): Promise<{ release(moved: boolean): void }>;
  /**
   * Closes the tab of a file that was deleted. Only called for files without unsaved edits: the
   * editor keeps an edited file open, marked deleted, so its text is not lost.
   */
  close(path: string): void;
}

export interface MenuState {
  readonly x: number;
  readonly y: number;
  /** The entry the menu was opened on; undefined is the project root. */
  readonly path: string | undefined;
}

const NOTICE_MS = 6000;

/** The folders left open last time, or undefined when this workspace has no saved state yet. */
function readExpanded(key: string): Set<string> | undefined {
  try {
    const stored = localStorage.getItem(key);
    if (stored === null) return undefined;
    const parsed: unknown = JSON.parse(stored);
    return new Set(Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : []);
  } catch {
    return undefined;
  }
}

/**
 * How many listed entries a new workspace opens by itself, in all: a hard cap. A small project
 * shows whole, as it would in any editor; a big one stays shut and loads folder by folder.
 */
const AUTO_OPEN_ENTRIES = 300;
/** Folder listings requested at once while opening by itself. */
const AUTO_OPEN_CONCURRENCY = 4;

function writeExpanded(key: string, paths: ReadonlySet<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify(Array.from(paths)));
  } catch {
    // Private windows can refuse storage: the folders then simply start collapsed next time.
  }
}

const withNames = (paths: ReadonlySet<string>, from: string, to: string): Set<string> =>
  new Set(Array.from(paths, (path) => rebase(path, from, to)));

export function createExplorerState(options: ExplorerOptions) {
  const { files } = options;
  const storageKey = `sprockt:${options.workspaceId}:explorer-expanded`;
  const [listings, setListings] = createSignal<Listings>(new Map());
  const saved = readExpanded(storageKey);
  const [expanded, setExpandedSet] = createSignal<ReadonlySet<string>>(saved ?? new Set<string>());
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set());
  const [focused, setFocused] = createSignal<string>();
  const [draft, setDraft] = createSignal<Draft>();
  const [problem, setProblem] = createSignal<NameProblem>();
  const [deleting, setDeleting] = createSignal<readonly string[]>();
  const [menu, setMenu] = createSignal<MenuState>();
  const [dropTarget, setDropTarget] = createSignal<string>();
  const [notice, setNotice] = createSignal<string>();
  const [busy, setBusy] = createSignal<"upload" | "zip">();
  const [filterOpen, setFilterOpen] = createSignal(false);
  const [filterQuery, setFilterQuery] = createSignal("");
  const [filterPaths, setFilterPaths] = createSignal<readonly string[]>([]);
  /** The focus request the tree acts on: a path, and a counter so asking twice moves it twice. */
  const [focusRequest, setFocusRequest] = createSignal<{ path: string; id: number }>();
  const loadTokens = new Map<string, number>();
  let preFilterScrollTop: number | undefined;
  let filterRefreshToken = 0;
  // A workspace seen for the first time opens its folders by itself, within a budget, until the
  // person does anything to the tree: after that the tree is theirs and keeps what they left.
  let autoOpen = saved === undefined;
  const autoOpener = createAutoOpener({
    limit: AUTO_OPEN_ENTRIES,
    concurrency: AUTO_OPEN_CONCURRENCY,
    list: (directory) => files.readdir(directory),
    open(directory, listing) {
      if (!autoOpen) return;
      setListings((previous) => new Map(previous).set(directory, listing));
      setExpanded(new Set(expanded()).add(directory));
    },
  });
  let anchor: string | undefined;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  let requests = 0;

  const rows = createMemo(() => {
    const query = filterOpen() ? filterQuery().trim() : "";
    if (query) return filterRows(filterPaths(), query, listings());
    return visibleRows(listings(), expanded(), draft());
  });
  const entries = createMemo(() => entryRows(rows()));
  /** The ancestor directory whose indentation guide should be emphasized. */
  const activeGuidePath = createMemo(() => {
    const target = focused() ?? options.active();
    if (!target) return undefined;
    const list = entries();
    const row = list.find(
      (candidate) =>
        candidate.path === target || (candidate.segments?.some((seg) => seg.path === target) ?? false),
    );
    if (!row) return undefined;
    if (row.kind === "directory" && row.expanded) return row.path;
    return row.ancestorPaths.at(-1);
  });
  /**
   * The one row that can be reached with Tab: the focused row, or the first when the focused one
   * is not on screen (its folder was collapsed or removed). There is always exactly one.
   */
  const tabStop = createMemo(() => {
    const current = focused();
    const list = entries();
    return list.some(
      (row) => row.path === current || (row.segments?.some((seg) => seg.path === current) ?? false),
    )
      ? current
      : list[0]?.path;
  });

  /** Directories that hold a file with unsaved edits, as far as their listings are known. */
  const dirtyDirectories = createMemo(() => {
    const directories = new Set<string>();
    for (const [directory, listing] of listings()) {
      const unsaved = listing.some(
        (entry) => entry.kind === "file" && options.hasUnsaved(joinPath(directory, entry.name)),
      );
      if (!unsaved) continue;
      for (const parent of ancestorsOf(`${directory}/x`)) directories.add(parent);
    }
    return directories;
  });

  function setExpanded(next: ReadonlySet<string>): void {
    setExpandedSet(next);
    writeExpanded(storageKey, next);
  }

  function say(text: string): void {
    setNotice(text);
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => setNotice(undefined), NOTICE_MS);
  }

  function failed(error: unknown): void {
    console.error("A file operation failed", error);
    if (error instanceof DestinationExistsError) {
      say(fill(copy.notices.moveExists, { name: baseName(error.path) }));
      return;
    }
    if (error instanceof FolderGoneError) {
      say(fill(copy.notices.folderGone, { path: error.path }));
      return;
    }
    say(fill(copy.notices.failed, { message: error instanceof Error ? error.message : String(error) }));
  }

  function kindOf(path: string): "file" | "directory" | undefined {
    return listings()
      .get(parentOf(path))
      ?.find((entry) => entry.name === baseName(path))?.kind;
  }

  function dropListings(directory: string): void {
    setListings((previous) => {
      const next = new Map(previous);
      for (const key of next.keys()) if (isSameOrInside(key, directory)) next.delete(key);
      return next;
    });
  }

  function forget(directory: string): void {
    dropListings(directory);
    const remaining = new Set(Array.from(expanded()).filter((path) => !isSameOrInside(path, directory)));
    if (remaining.size !== expanded().size) setExpanded(remaining);
  }

  /**
   * Lists a directory. One that is gone loses its listings; its open state is kept unless
   * `prune`, because a folder replaced from the terminal is gone for a moment and should come
   * back open. Only the first listing after a reload prunes, to forget folders deleted meanwhile.
   */
  async function load(directory: string, prune = false): Promise<void> {
    const token = (loadTokens.get(directory) ?? 0) + 1;
    loadTokens.set(directory, token);
    let listing: DirEntry[] | undefined;
    try {
      listing = await files.readdir(directory);
    } catch (error) {
      console.error(`Could not list ${directory || "the project"}`, error);
      return;
    }
    // A newer listing of the same directory is already on its way.
    if (loadTokens.get(directory) !== token) return;
    if (listing === undefined && directory !== "") return prune ? forget(directory) : dropListings(directory);
    setListings((previous) => new Map(previous).set(directory, listing ?? []));
    if (listing && autoOpen) autoOpener.offer(directory, listing);
  }

  /** Lists the project root and every directory that is open. */
  function loadAll(): Promise<unknown> {
    const known = [""].concat(Array.from(expanded()), Array.from(listings().keys()));
    return Promise.all(Array.from(new Set(known), (directory) => load(directory)));
  }

  function refreshFilterPaths(): void {
    const token = (filterRefreshToken += 1);
    void (async () => {
      try {
        const list = await files.list();
        if (filterRefreshToken === token) setFilterPaths(list);
      } catch {
        // Ignore transient listing failures while filtering.
      }
    })();
  }

  function refresh(change: FileChange): void {
    if (filterOpen()) refreshFilterPaths();
    if (change.reset) {
      void Promise.all([""].concat(Array.from(expanded())).map((directory) => load(directory, true)));
      return;
    }
    const directories = new Set<string>();
    for (const path of change.paths) directories.add(parentOf(path)).add(path);
    // A directory that was replaced or moved changes everything below it, so every listing held
    // under a changed path is stale, expanded or not.
    for (const directory of listings().keys()) {
      if (change.paths.some((path) => isSameOrInside(directory, path))) directories.add(directory);
    }
    for (const directory of directories) {
      if (directory === "" || expanded().has(directory) || listings().has(directory)) void load(directory);
    }
  }

  /** Keeps open folders, the selection and the editor on the entry that moved. */
  function followMove(from: string, to: string): void {
    setExpanded(withNames(expanded(), from, to));
    setSelected(withNames(selected(), from, to));
    forget(from);
  }

  /**
   * Moves under the editor's lock on both ends, so no save writes the old path while the move
   * runs or before the editor has followed it.
   */
  async function lockedMove(from: string, to: string): Promise<void> {
    const lock = await options.lock([from, to]);
    let moved = false;
    try {
      await files.move(from, to);
      moved = true;
    } finally {
      lock.release(moved);
    }
  }

  /** The person acted on the tree: from here on it keeps exactly what they leave open. */
  function takeOver(): void {
    autoOpen = false;
    autoOpener.stop();
  }

  async function expand(directory: string): Promise<void> {
    if (directory === "") return;
    const missing = ancestorsOf(`${directory}/x`).filter((path) => !expanded().has(path));
    if (missing.length === 0) return;
    setExpanded(new Set(Array.from(expanded()).concat(missing)));
    await Promise.all(missing.map((folder) => load(folder)));
  }

  function collapse(directory: string): void {
    takeOver();
    const next = new Set(expanded());
    next.delete(directory);
    // The listing stays: it is what lets a collapsed folder show that a file inside is unsaved.
    setExpanded(next);
    // Focus inside a folder that just closed moves to the folder, not into thin air.
    const inside = focused();
    if (inside && isInside(inside, directory)) setFocused(directory);
  }

  function toggle(directory: string): void {
    takeOver();
    if (expanded().has(directory)) collapse(directory);
    else void expand(directory);
  }

  function collapseAll(): void {
    takeOver();
    setExpanded(new Set<string>());
    const inside = focused();
    if (inside && parentOf(inside) !== "") setFocused(ancestorsOf(inside)[0]);
  }

  function focusPath(path: string): void {
    setFocused(path);
    requests += 1;
    setFocusRequest({ path, id: requests });
  }

  function select(path: string, how: "replace" | "toggle" | "range" = "replace"): void {
    setFocused(path);
    if (how === "toggle") {
      const next = new Set(selected());
      if (!next.delete(path)) next.add(path);
      setSelected(next);
      anchor = path;
      return;
    }
    if (how === "range" && anchor) {
      setSelected(new Set(rangeBetween(entries(), anchor, path)));
      return;
    }
    setSelected(new Set([path]));
    anchor = path;
  }

  function selectAll(): void {
    const all = entries().map((row) => row.path);
    if (all.length === 0) return;
    setSelected(new Set(all));
    anchor = all[0];
  }

  function openFilter(seed = "", scrollTop?: number): void {
    if (!filterOpen()) preFilterScrollTop = scrollTop;
    setFilterOpen(true);
    if (seed) setFilterQuery(seed);
    refreshFilterPaths();
  }

  function closeFilter(): number | undefined {
    const savedScroll = preFilterScrollTop;
    preFilterScrollTop = undefined;
    setFilterOpen(false);
    setFilterQuery("");
    return savedScroll;
  }

  /** Nothing selected: the next new file or upload goes to the project root. */
  function clearSelection(): void {
    setSelected(new Set<string>());
    setFocused(undefined);
    anchor = undefined;
  }

  /** Selects a file and shows it: opens the folders above it. */
  async function reveal(path: string): Promise<void> {
    await expand(parentOf(path));
    setSelected(new Set([path]));
    anchor = path;
  }

  function currentTarget(): { path: string | undefined; directory: string } {
    const path = focused() ?? Array.from(selected()).at(-1);
    return { path, directory: targetDirectory(path, path === undefined ? undefined : kindOf(path)) };
  }

  async function beginCreate(kind: "file" | "directory", directory?: string): Promise<void> {
    if (!files.writable()) return;
    takeOver();
    const parent = directory ?? currentTarget().directory;
    setProblem(undefined);
    await expand(parent);
    setDraft({ mode: "create", kind, parent });
  }

  function beginRename(path: string): void {
    if (!files.writable()) return;
    takeOver();
    setProblem(undefined);
    setDraft({ mode: "rename", path });
  }

  function cancelDraft(): void {
    setDraft(undefined);
    setProblem(undefined);
  }

  async function runDraft(current: Draft, name: string): Promise<string> {
    if (current.mode === "rename") {
      const to = joinPath(parentOf(current.path), name);
      await lockedMove(current.path, to);
      followMove(current.path, to);
      return to;
    }
    const path = joinPath(current.parent, name);
    if (current.kind === "directory") await files.mkdir(path);
    else await files.create(path);
    return path;
  }

  /** Applies the name typed into the inline box. False when it was refused and the box stays open. */
  async function commitDraft(typed: string): Promise<boolean> {
    const current = draft();
    if (!current) return true;
    const name = typed.trim();
    const parent = current.mode === "rename" ? parentOf(current.path) : current.parent;
    if (current.mode === "rename" && name === baseName(current.path)) {
      cancelDraft();
      return true;
    }
    const taken = (listings().get(parent) ?? [])
      .map((entry) => entry.name)
      .filter((existing) => current.mode === "create" || existing !== baseName(current.path));
    const refused = checkName(name, taken);
    if (refused) {
      setProblem(refused);
      return false;
    }
    cancelDraft();
    try {
      const path = await runDraft(current, name);
      // Selected before the listing is refreshed: whatever the person does next starts from here.
      select(path);
      await load(parent);
      const opensInEditor = current.mode === "create" && current.kind === "file";
      if (opensInEditor) options.open(path);
      else focusPath(path);
    } catch (error) {
      failed(error);
      // The listing the name was checked against is out of date: show what is really there.
      await load(parent);
    }
    return true;
  }

  async function requestDelete(paths: readonly string[]): Promise<void> {
    if (!files.writable()) return;
    const doomed = topLevelPaths(paths);
    if (doomed.length === 0) return;
    setDeleting(doomed);
  }

  async function confirmDelete(): Promise<void> {
    const doomed = deleting();
    setDeleting(undefined);
    if (!doomed) return;
    try {
      await Promise.all(doomed.map((path) => files.remove(path)));
      // Tabs of the deleted files, and of everything inside deleted folders, close with them.
      // A file with unsaved edits stays open in the editor, marked deleted, so nothing is lost.
      for (const open of options.openPaths()) {
        if (doomed.some((path) => isSameOrInside(open, path)) && !options.hasUnsaved(open))
          options.close(open);
      }
    } catch (error) {
      failed(error);
    }
    for (const path of doomed) forget(path);
    setSelected(new Set<string>());
    await Promise.all(Array.from(new Set(doomed.map(parentOf)), (directory) => load(directory)));
  }

  async function moveInto(paths: readonly string[], directory: string): Promise<void> {
    const moving = topLevelPaths(paths);
    if (!files.writable() || !canMoveInto(moving, directory)) return;
    takeOver();
    try {
      const existing = new Set((await files.readdir(directory))?.map((entry) => entry.name));
      const names = moving.map(baseName);
      const clash = names.find((name, index) => existing.has(name) || names.indexOf(name) !== index);
      if (clash !== undefined) return say(fill(copy.notices.moveExists, { name: clash }));
      await Promise.all(
        moving.map(async (path) => {
          const to = joinPath(directory, baseName(path));
          await lockedMove(path, to);
          followMove(path, to);
        }),
      );
      await expand(directory);
    } catch (error) {
      failed(error);
    }
    // Success or not, show what is really there now.
    await Promise.all(Array.from(new Set(moving.map(parentOf).concat(directory)), (parent) => load(parent)));
  }

  async function upload(items: readonly UploadItem[], directory: string): Promise<void> {
    if (items.length === 0 || !files.writable()) return;
    takeOver();
    setBusy("upload");
    try {
      const result = await files.upload(items, directory);
      if (result.skipped > 0)
        say(
          result.skipped === 1
            ? copy.notices.skippedOne
            : fill(copy.notices.skipped, { count: result.skipped }),
        );
      await expand(directory);
      await load(directory);
    } catch (error) {
      failed(error);
    } finally {
      setBusy(undefined);
    }
  }

  async function downloadZip(): Promise<void> {
    setBusy("zip");
    try {
      downloadBlob(await files.exportZip(), `${options.workspaceId}.zip`);
    } catch (error) {
      say(fill(copy.notices.zipFailed, { message: error instanceof Error ? error.message : String(error) }));
    } finally {
      setBusy(undefined);
    }
  }

  /** Arrow keys, Home and End; with `extend` (shift) the selection grows with the focus. */
  function moveFocus(key: NavigationKey, extend: boolean): void {
    const step = navigate(entries(), focused(), key);
    if (step.expand) {
      takeOver();
      void expand(step.expand);
    }
    if (step.collapse) collapse(step.collapse);
    if (!step.focus) return;
    focusPath(step.focus);
    if (extend) select(step.focus, "range");
  }

  function openMenu(
    event: MouseEvent | { clientX: number; clientY: number },
    path: string | undefined,
  ): void {
    if (path !== undefined && !selected().has(path)) select(path);
    setMenu({ x: event.clientX, y: event.clientY, path });
  }

  const stopListening = files.subscribe(refresh);
  onCleanup(() => {
    stopListening();
    clearTimeout(noticeTimer);
  });
  void loadAll();

  return {
    rows,
    entries,
    expanded,
    selected,
    focused,
    focusRequest,
    draft,
    problem,
    deleting,
    menu,
    dropTarget,
    notice,
    busy,
    dirtyDirectories,
    tabStop,
    activeGuidePath,
    listings,
    filterOpen,
    filterQuery,
    setFilterQuery,
    openFilter,
    closeFilter,
    setDropTarget,
    setMenu,
    setProblem,
    setFocused,
    /** False in a tab that lost the workspace to another tab: the tree only shows, it does not change. */
    writable: files.writable,
    focusPath,
    select,
    selectAll,
    clearSelection,
    toggle,
    expand,
    collapse,
    collapseAll,
    reveal,
    kindOf,
    currentTarget,
    beginCreate,
    beginRename,
    cancelDraft,
    commitDraft,
    requestDelete,
    cancelDelete: () => setDeleting(undefined),
    confirmDelete,
    moveInto,
    upload,
    downloadZip,
    moveFocus,
    openMenu,
    say,
    fail: failed,
  };
}

export type ExplorerState = ReturnType<typeof createExplorerState>;
