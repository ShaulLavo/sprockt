import { Fragment, memo, useEffect, useRef, useState, type RefObject } from "react";
import type React from "react";
import type { EditorStore } from "../editor/store";
import { baseName, parentOf, type NameProblem } from "../files/paths";
import { isHeavyName } from "../files/tree";
import { Scope, useValue } from "../lib/react";
import { createEffect, on, onCleanup } from "../lib/reactive";
import { workspaceName } from "../workspace/hint";
import { useWorkspace, type WorkspaceSession } from "../workspace/session";
import { ConfirmDialog } from "./ConfirmDialog";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { copy, fill } from "./copy";
import { fileKindOf } from "./file-types";
import { FILE_ICONS, Icon } from "./icons";
import {
  canMoveInto,
  renameSelection,
  splitFilename,
  stickyAncestors,
  targetDirectory,
  topLevelPaths,
  type DraftRow,
  type EntryRow,
} from "./model";
import { createExplorerState, type ExplorerState, type MenuState } from "./state";
import { itemsFromDrop, itemsFromPicker } from "./upload";
import "./explorer.css";

/** Marks a drag that started in the tree, as opposed to files dragged in from the desktop. */
const TREE_DRAG = "application/x-sprockt-paths";
/** How long a dragged item hovers over a closed folder before it opens. */
const HOVER_OPEN_MS = 600;
/** Idle timeout before clearing the synchronous `data-is-scrolling` suppression attribute. */
const SCROLL_IDLE_MS = 60;
/** Edge zone (in CSS pixels) that triggers vertical auto-scroll during a drag. */
const DRAG_EDGE_PX = 40;
/** Max pixels scrolled per animation frame when dragging at the very edge. */
const DRAG_MAX_SPEED_PX = 16;

/** `base` plus every flag that is on, as one class attribute. */
function classes(base: string, flags: Readonly<Record<string, boolean>>): string {
  return [base].concat(Object.keys(flags).filter((name) => flags[name])).join(" ");
}

/** True when a keydown event is part of an active IME composition (CJK, dead keys, etc.). */
function isComposingEvent(event: React.KeyboardEvent): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}

/** True for printable single-character keys that seed inline tree filtering. */
function isFilterSeedKey(event: React.KeyboardEvent): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  if (isComposingEvent(event)) return false;
  return event.key.length === 1 && event.key !== " ";
}

function NameInput(props: {
  state: ExplorerState;
  initial: string;
  label: string;
  problem: NameProblem | undefined;
}) {
  const input = useRef<HTMLInputElement>(null);
  const settled = useRef(false);
  // Whether the person moved on (clicked elsewhere, pressed Tab), as opposed to something else
  // taking focus, such as the editor finishing the load of the file that was just clicked.
  const leftOnPurpose = useRef(false);

  useEffect(() => {
    const element = input.current;
    const noteLeaving = (event: Event) => {
      if (event.target !== element) leftOnPurpose.current = true;
    };
    const noteTab = (event: KeyboardEvent) => {
      if (event.key === "Tab") leftOnPurpose.current = true;
    };
    element?.focus();
    const [start, end] = props.initial ? renameSelection(props.initial) : [0, 0];
    element?.setSelectionRange(start, end);
    document.addEventListener("pointerdown", noteLeaving, true);
    document.addEventListener("keydown", noteTab, true);
    return () => {
      document.removeEventListener("pointerdown", noteLeaving, true);
      document.removeEventListener("keydown", noteTab, true);
    };
    // The box opens once with its initial name; later renders only update the problem.
  }, []);

  async function commit(): Promise<boolean> {
    const accepted = await props.state.commitDraft(input.current?.value ?? "");
    settled.current = accepted;
    return accepted;
  }

  function cancel(): void {
    settled.current = true;
    props.state.cancelDraft();
    const current = props.state.focused();
    if (current) props.state.focusPath(current);
  }

  async function onBlur(): Promise<void> {
    if (settled.current) return;
    // Focus taken by something else (not the person) must not end the edit: take it back.
    if (!leftOnPurpose.current) return void queueMicrotask(() => input.current?.focus());
    // Clicking away keeps a valid name and drops an invalid or unchanged one.
    if (!(await commit())) cancel();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    event.stopPropagation();
    if (isComposingEvent(event)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
    if (event.key === "Enter") {
      event.preventDefault();
      void commit();
    }
  }

  return (
    <>
      <input
        ref={input}
        className={props.problem !== undefined ? "tree-input invalid" : "tree-input"}
        data-testid="tree-input"
        aria-label={props.label}
        aria-invalid={props.problem !== undefined}
        defaultValue={props.initial}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        onChange={() => props.state.setProblem(undefined)}
        onKeyDown={onKeyDown}
        onBlur={() => void onBlur()}
      />
      {props.problem ? (
        <span className="tree-problem" role="alert">
          {copy.problems[props.problem]}
        </span>
      ) : null}
    </>
  );
}

/** Hairline vertical indentation guides aligned to each ancestor's chevron lane. */
function RowGuides(props: {
  readonly depth: number;
  readonly ancestorPaths: readonly string[];
  readonly activeGuide: string | undefined;
}) {
  if (props.depth <= 0) return null;
  const levels = Array.from({ length: props.depth }, (_, level) => level);
  return (
    <span className="row-guides" aria-hidden="true">
      {levels.map((level) => {
        const active = props.activeGuide !== undefined && props.ancestorPaths[level] === props.activeGuide;
        return (
          <span
            key={level}
            className={active ? "row-guide is-active" : "row-guide"}
            style={{ "--guide-level": level } as React.CSSProperties}
          />
        );
      })}
    </span>
  );
}

/** Extension-preserving filename display so narrow sidebars keep `.tsx` / `.test.ts` visible. */
function FileName(props: { readonly name: string }) {
  const { stem, ext } = splitFilename(props.name);
  if (!ext) return <span className="name-stem">{stem}</span>;
  return (
    <>
      <span className="name-stem">{stem}</span>
      <span className="name-ext">{ext}</span>
    </>
  );
}

interface TreeActions {
  state: ExplorerState;
  store: EditorStore;
  isDirty(path: string): boolean;
  isScrolling(): boolean;
  onRowKeyDown(event: React.KeyboardEvent<HTMLElement>): void;
  dragStart(event: React.DragEvent, path: string): void;
  dragEnd(): void;
  dragOver(event: React.DragEvent, directory: string, closedDirectory?: string): void;
  drop(event: React.DragEvent, directory: string): void;
}

interface EntryItemProps {
  row: EntryRow;
  actions: TreeActions;
}

function EntryItemView({ row, actions }: EntryItemProps) {
  const { state, store } = actions;
  const path = row.path;
  const isDirectory = row.kind === "directory";
  const segments = row.segments;
  const directoryOfDrop = isDirectory ? path : parentOf(path);
  const live = useValue(() => {
    const selectedSet = state.selected();
    const focused = state.focused();
    const drop = state.dropTarget();
    const tabStop = state.tabStop();
    const matchesPath = (candidate: string | undefined) =>
      candidate === path || (segments?.some((seg) => seg.path === candidate) ?? false);
    const anySegmentSelected = segments?.some((seg) => selectedSet.has(seg.path)) ?? false;
    const anySegmentDirty =
      isDirectory &&
      (state.dirtyDirectories().has(path) ||
        (segments?.some((seg) => state.dirtyDirectories().has(seg.path)) ?? false));
    const anySegmentDrop =
      isDirectory && (drop === path || (segments?.some((seg) => seg.path === drop) ?? false));
    return {
      active: store.active() === path,
      selected: selectedSet.has(path) || anySegmentSelected,
      focusedSegment: segments?.find((seg) => seg.path === focused)?.path,
      dropSegment: segments?.find((seg) => seg.path === drop)?.path,
      fileDirty: !isDirectory && actions.isDirty(path),
      folderDirty: anySegmentDirty,
      drop: anySegmentDrop,
      tabStop: matchesPath(tabStop),
      writable: state.writable(),
      problem: row.editing ? state.problem() : undefined,
      activeGuide: state.activeGuidePath(),
    };
  });

  const rowProps = {
    "data-testid": "tree-row",
    "data-path": path,
    "data-kind": row.kind,
    "data-chain": segments ? segments.map((seg) => seg.path).join(",") : undefined,
    style: { "--depth": row.depth } as React.CSSProperties,
  };

  if (row.editing) {
    return (
      <li className="tree-item">
        <div className="row editing" {...rowProps}>
          <RowGuides depth={row.depth} ancestorPaths={row.ancestorPaths} activeGuide={live.activeGuide} />
          <RowIcons row={row} />
          <NameInput state={state} initial={row.name} label={copy.actions.rename} problem={live.problem} />
        </div>
      </li>
    );
  }

  const className = classes("row", {
    "is-dir": isDirectory,
    "is-file": !isDirectory,
    "is-open": row.expanded,
    "is-active": live.active,
    "is-selected": live.selected,
    "is-dirty": live.fileDirty || live.folderDirty,
    "is-dim": isHeavyName(row.name) || (segments?.some((seg) => isHeavyName(seg.name)) ?? false),
    "is-drop": live.drop && !live.dropSegment,
    "is-compact": Boolean(segments),
  });

  function toggleRow(): void {
    if (segments && row.expanded) {
      state.collapse(segments[0]!.path);
      return;
    }
    state.toggle(path);
  }

  return (
    <li className="tree-item" data-selected={live.selected ? "true" : undefined}>
      <button
        type="button"
        className={className}
        {...rowProps}
        aria-label={segments ? segments.map((seg) => seg.name).join("/") : row.name}
        tabIndex={live.tabStop ? 0 : -1}
        aria-expanded={isDirectory ? row.expanded : undefined}
        aria-current={live.active ? "true" : undefined}
        aria-describedby={live.fileDirty ? "tree-unsaved" : undefined}
        draggable={live.writable}
        onFocus={() => {
          if (!segments?.some((seg) => seg.path === state.focused())) state.setFocused(path);
        }}
        onClick={(event) => {
          if (event.shiftKey) return state.select(path, "range");
          if (event.metaKey || event.ctrlKey) return state.select(path, "toggle");
          state.select(path);
          if (isDirectory) toggleRow();
          else store.open(path);
        }}
        onKeyDown={actions.onRowKeyDown}
        onContextMenu={(event) => {
          if (actions.isScrolling()) return;
          event.preventDefault();
          event.stopPropagation();
          state.openMenu(event, path);
        }}
        onDragStart={(event) => actions.dragStart(event, path)}
        onDragEnd={() => actions.dragEnd()}
        onDragOver={(event) => actions.dragOver(event, directoryOfDrop, isDirectory ? path : undefined)}
        onDrop={(event) => actions.drop(event, directoryOfDrop)}
      >
        <RowGuides depth={row.depth} ancestorPaths={row.ancestorPaths} activeGuide={live.activeGuide} />
        <RowIcons row={row} />
        {segments ? (
          <span className="name is-segments">
            {segments.map((segment, index) => (
              <Fragment key={segment.path}>
                {index > 0 ? (
                  <span className="folder-sep" aria-hidden="true">
                    /
                  </span>
                ) : null}
                <span
                  className={classes("folder-segment", {
                    "is-focused-seg": live.focusedSegment === segment.path,
                    "is-drop-seg": live.dropSegment === segment.path,
                  })}
                  data-segment-path={segment.path}
                  onClick={(event) => {
                    if (index === segments.length - 1 || !row.expanded) return;
                    event.stopPropagation();
                    if (event.shiftKey) return state.select(segment.path, "range");
                    if (event.metaKey || event.ctrlKey) return state.select(segment.path, "toggle");
                    state.select(segment.path);
                  }}
                  onDoubleClick={(event) => {
                    event.stopPropagation();
                    if (!matchMedia("(pointer: coarse)").matches) state.beginRename(segment.path);
                  }}
                  onContextMenu={(event) => {
                    if (actions.isScrolling()) return;
                    event.preventDefault();
                    event.stopPropagation();
                    state.openMenu(event, segment.path);
                  }}
                  onDragOver={(event) => actions.dragOver(event, segment.path)}
                  onDrop={(event) => actions.drop(event, segment.path)}
                >
                  {segment.name}
                </span>
              </Fragment>
            ))}
          </span>
        ) : (
          <span
            className="name"
            title={row.name}
            onDoubleClick={() => {
              // A quick second tap is not a request to rename; touch screens have the menu.
              if (!matchMedia("(pointer: coarse)").matches) state.beginRename(path);
            }}
          >
            {isDirectory ? <span className="name-stem">{row.name}</span> : <FileName name={row.name} />}
          </span>
        )}
        {row.loading ? <span className="tree-spinner" aria-hidden="true" /> : null}
        {live.fileDirty ? (
          <>
            <span className="dirty" aria-hidden="true" />
            <span className="git git-m" aria-hidden="true">
              M
            </span>
          </>
        ) : null}
        {live.folderDirty ? <span className="git-dot" aria-hidden="true" /> : null}
      </button>
      <button
        type="button"
        className="row-more"
        tabIndex={-1}
        aria-label={copy.actions.more}
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          state.openMenu({ clientX: box.left, clientY: box.bottom }, path);
        }}
      >
        <Icon name="more" />
      </button>
    </li>
  );
}

function sameStringList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameSegments(a: EntryRow["segments"], b: EntryRow["segments"]): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((seg, index) => seg.path === b[index]?.path && seg.name === b[index]?.name);
}

/** Rows are rebuilt on every change; a row whose fields are all the same does not render again. */
function sameEntry(previous: EntryItemProps, next: EntryItemProps): boolean {
  if (previous.actions !== next.actions) return false;
  const a = previous.row;
  const b = next.row;
  return (
    a.key === b.key &&
    a.path === b.path &&
    a.name === b.name &&
    a.kind === b.kind &&
    a.depth === b.depth &&
    a.expanded === b.expanded &&
    a.loading === b.loading &&
    a.editing === b.editing &&
    sameStringList(a.ancestorPaths, b.ancestorPaths) &&
    sameSegments(a.segments, b.segments)
  );
}

const EntryItem = memo(EntryItemView, sameEntry);

function RowIcons(props: { row: EntryRow }) {
  if (props.row.kind === "directory") {
    return (
      <>
        <Icon name={props.row.expanded ? "chevronDown" : "chevronRight"} class="chev" />
        <Icon name={props.row.expanded ? "folderOpen" : "folder"} class="ft" />
      </>
    );
  }
  const kind = fileKindOf(props.row.name);
  return (
    <>
      <span className="chev-space" />
      <Icon name={FILE_ICONS[kind.icon]} class={`ft ${kind.tone}`} />
    </>
  );
}

function DraftItem(props: { row: DraftRow; actions: TreeActions }) {
  const problem = useValue(props.actions.state.problem);
  const activeGuide = useValue(props.actions.state.activeGuidePath);
  return (
    <li className="tree-item">
      <div
        className="row editing"
        data-testid="tree-draft"
        style={{ "--depth": props.row.depth } as React.CSSProperties}
      >
        <RowGuides
          depth={props.row.depth}
          ancestorPaths={props.row.ancestorPaths}
          activeGuide={activeGuide}
        />
        <span className="chev-space" />
        <Icon name={props.row.kind === "directory" ? "folder" : "file"} class="ft" />
        <NameInput
          state={props.actions.state}
          initial=""
          label={props.row.kind === "directory" ? copy.actions.newFolder : copy.actions.newFile}
          problem={problem}
        />
      </div>
    </li>
  );
}

interface Pickers {
  readonly file: React.RefObject<HTMLInputElement | null>;
  readonly folder: React.RefObject<HTMLInputElement | null>;
}

/** The explorer's state with the tree's event handlers, created once per mounted explorer. */
function createTree(
  store: EditorStore,
  workspace: WorkspaceSession,
  pickers: Pickers,
  scroller: RefObject<HTMLDivElement | null>,
  focusFilter: () => void,
) {
  const state = createExplorerState({
    files: workspace.files,
    workspaceId: workspace.id,
    open: (path) => store.open(path),
    active: store.active,
    hasUnsaved: (path) => store.hasUnsaved(path),
    openPaths: () => store.tabs().map((tab) => tab.path),
    lock: (paths) => store.lockPaths(paths),
    close: (path) => store.close(path),
  });
  let uploadDirectory = "";
  let dragged: string[] = [];
  let hoverTimer: { path: string; handle: ReturnType<typeof setTimeout> } | undefined;
  let edgeVelocity = 0;
  let edgeFrame: number | undefined;

  createEffect(
    on(store.active, (path) => {
      if (path) void state.reveal(path);
    }),
  );

  function stopEdgeScroll(): void {
    edgeVelocity = 0;
    if (edgeFrame !== undefined) {
      cancelAnimationFrame(edgeFrame);
      edgeFrame = undefined;
    }
  }

  function updateEdgeScroll(clientY: number): void {
    const element = scroller.current;
    if (!element) return stopEdgeScroll();
    const rect = element.getBoundingClientRect();
    const topDist = clientY - rect.top;
    const bottomDist = rect.bottom - clientY;
    if (topDist >= 0 && topDist < DRAG_EDGE_PX) {
      edgeVelocity = -Math.ceil(((DRAG_EDGE_PX - topDist) / DRAG_EDGE_PX) * DRAG_MAX_SPEED_PX);
    } else if (bottomDist >= 0 && bottomDist < DRAG_EDGE_PX) {
      edgeVelocity = Math.ceil(((DRAG_EDGE_PX - bottomDist) / DRAG_EDGE_PX) * DRAG_MAX_SPEED_PX);
    } else {
      return stopEdgeScroll();
    }
    if (edgeFrame !== undefined) return;
    const step = () => {
      edgeFrame = undefined;
      const target = scroller.current;
      if (!target || edgeVelocity === 0) return;
      target.scrollTop += edgeVelocity;
      edgeFrame = requestAnimationFrame(step);
    };
    edgeFrame = requestAnimationFrame(step);
  }

  onCleanup(() => {
    clearTimeout(hoverTimer?.handle);
    stopEdgeScroll();
  });

  function pick(directory: string, folder: boolean): void {
    uploadDirectory = directory;
    (folder ? pickers.folder : pickers.file).current?.click();
  }

  function uploaded(input: HTMLInputElement): void {
    void state.upload(itemsFromPicker(input.files), uploadDirectory);
    input.value = "";
  }

  function selectionOrFocus(): string[] {
    const focused = state.focused();
    const chosen = Array.from(state.selected());
    const focusedIsContext =
      focused !== undefined && state.entries().some((row) => row.path === focused && row.contextOnly);
    if (focused && !state.selected().has(focused) && !focusedIsContext) return [focused];
    if (chosen.length > 0) return chosen;
    return focused && !focusedIsContext ? [focused] : [];
  }

  function onRowKeyDown(event: React.KeyboardEvent<HTMLElement>): void {
    if (event.altKey || event.target instanceof HTMLInputElement) return;
    if (isComposingEvent(event)) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      state.selectAll();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      event.stopPropagation();
      state.openFilter("", scroller.current?.scrollTop);
      queueMicrotask(focusFilter);
      return;
    }
    const arrow = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"] as const;
    const key = arrow.find((name) => name === event.key);
    if (key && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      state.moveFocus(key, event.shiftKey);
      return;
    }
    const focused = state.focused();
    if (event.key === " " && focused && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      state.select(focused, "toggle");
      return;
    }
    if (event.key === "F2" && focused) {
      event.preventDefault();
      state.beginRename(focused);
      return;
    }
    if (event.key === "Delete" || (event.key === "Backspace" && event.metaKey)) {
      event.preventDefault();
      void state.requestDelete(selectionOrFocus());
      return;
    }
    if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      event.preventDefault();
      const box = (event.target as HTMLElement).getBoundingClientRect();
      state.openMenu({ clientX: box.left + 24, clientY: box.bottom }, focused);
      return;
    }
    if (isFilterSeedKey(event)) {
      event.preventDefault();
      state.openFilter(event.key, scroller.current?.scrollTop);
      queueMicrotask(focusFilter);
    }
  }

  function dragStart(event: React.DragEvent, path: string): void {
    dragged = state.selected().has(path) ? Array.from(state.selected()) : [path];
    event.dataTransfer.setData(TREE_DRAG, JSON.stringify(dragged));
    event.dataTransfer.setData("text/plain", dragged.map(baseName).join("\n"));
    event.dataTransfer.effectAllowed = "move";
  }

  function stopHoverOpen(): void {
    clearTimeout(hoverTimer?.handle);
    hoverTimer = undefined;
  }

  function dragEnd(): void {
    dragged = [];
    stopHoverOpen();
    stopEdgeScroll();
    state.setDropTarget(undefined);
  }

  /** What a drop here would do: move our own entries, or copy in files from the desktop. */
  function dropEffect(event: React.DragEvent, directory: string): "move" | "copy" | undefined {
    if (!state.writable()) return undefined;
    if (dragged.length > 0) return canMoveInto(topLevelPaths(dragged), directory) ? "move" : undefined;
    return event.dataTransfer?.types.includes("Files") ? "copy" : undefined;
  }

  function dragOver(event: React.DragEvent, directory: string, closedDirectory?: string): void {
    event.stopPropagation();
    updateEdgeScroll(event.clientY);
    const effect = dropEffect(event, directory);
    if (!effect || !event.dataTransfer) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = effect;
    state.setDropTarget(directory);
    const closed = closedDirectory !== undefined && !state.expanded().has(closedDirectory);
    if (!closed || hoverTimer?.path === closedDirectory) return;
    stopHoverOpen();
    hoverTimer = {
      path: closedDirectory,
      handle: setTimeout(() => void state.expand(closedDirectory), HOVER_OPEN_MS),
    };
  }

  function drop(event: React.DragEvent, directory: string): void {
    event.stopPropagation();
    const effect = dropEffect(event, directory);
    const transfer = event.dataTransfer;
    const moving = dragged;
    dragEnd();
    if (!effect || !transfer) return;
    event.preventDefault();
    if (effect === "move") void state.moveInto(moving, directory);
    // The transfer is only readable inside the event, so the entries are taken right here.
    else void itemsFromDrop(transfer).then((items) => state.upload(items, directory), state.fail);
  }

  const actions: TreeActions = {
    state,
    store,
    isDirty: (path) => store.hasUnsaved(path),
    isScrolling: () => Boolean(scroller.current && "isScrolling" in scroller.current.dataset),
    onRowKeyDown,
    dragStart,
    dragEnd,
    dragOver,
    drop,
  };

  function menuItems(path: string | undefined): MenuItem[] {
    const download: MenuItem = {
      label: copy.actions.download,
      testId: "menu-download",
      run: () => void state.downloadZip(),
    };
    // A tab that lost the workspace can still hand out a copy, but changes nothing.
    if (!state.writable()) return path === undefined ? [download] : [];
    const directory = targetDirectory(path, path === undefined ? undefined : state.kindOf(path));
    const items: MenuItem[] = [
      {
        label: copy.actions.newFile,
        testId: "menu-new-file",
        run: () => void state.beginCreate("file", directory),
      },
      {
        label: copy.actions.newFolder,
        testId: "menu-new-folder",
        run: () => void state.beginCreate("directory", directory),
      },
      { label: copy.actions.uploadFiles, testId: "menu-upload-files", run: () => pick(directory, false) },
      { label: copy.actions.uploadFolder, testId: "menu-upload-folder", run: () => pick(directory, true) },
    ];
    if (path === undefined) return items.concat(download);
    return items.concat(
      { label: copy.actions.rename, hint: "F2", testId: "menu-rename", run: () => state.beginRename(path) },
      {
        label: copy.actions.delete,
        hint: "Del",
        danger: true,
        testId: "menu-delete",
        run: () =>
          void state.requestDelete(state.selected().has(path) ? Array.from(state.selected()) : [path]),
      },
    );
  }

  /** The open menu with its items; a menu with nothing in it does not open. */
  function openMenu(): (MenuState & { items: MenuItem[] }) | undefined {
    const menu = state.menu();
    const items = menu ? menuItems(menu.path) : [];
    return menu && items.length > 0 ? { ...menu, items } : undefined;
  }

  function closeMenu(menu: MenuState, escaped: boolean | undefined): void {
    const origin = menu.path ?? state.tabStop();
    state.setMenu(undefined);
    // Escape hands focus back to the row the menu came from.
    if (escaped && origin) state.focusPath(origin);
  }

  function confirmation() {
    const paths = state.deleting();
    if (!paths) return undefined;
    const first = paths[0] ?? "";
    if (paths.length > 1)
      return { ...copy.confirmMany, title: fill(copy.confirmMany.title, { count: paths.length }) };
    const text = state.kindOf(first) === "directory" ? copy.confirmFolder : copy.confirmFile;
    return { ...text, title: fill(text.title, { name: baseName(first) }) };
  }

  return { state, actions, pick, uploaded, openMenu, closeMenu, confirmation, stopEdgeScroll };
}

function readSavedScroll(key: string): number {
  try {
    const raw = sessionStorage.getItem(key);
    const parsed = raw ? Number(raw) : 0;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

function writeSavedScroll(key: string, top: number): void {
  try {
    sessionStorage.setItem(key, String(Math.round(top)));
  } catch {
    // Ignore storage errors in private browsing.
  }
}

function ExplorerBody(props: {
  tree: ReturnType<typeof createTree>;
  filePicker: RefObject<HTMLInputElement | null>;
  folderPicker: RefObject<HTMLInputElement | null>;
  scroller: RefObject<HTMLDivElement | null>;
  filterInput: RefObject<HTMLInputElement | null>;
}) {
  const { tree, filePicker, folderPicker, scroller, filterInput } = props;
  const workspace = useWorkspace();
  const pane = useRef<HTMLElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const scrollRestored = useRef(false);
  const [sticky, setSticky] = useState<readonly EntryRow[]>([]);
  const { state, actions } = tree;
  const view = useValue(() => ({
    rows: state.rows(),
    entries: state.entries(),
    writable: state.writable(),
    busy: state.busy(),
    rootDrop: state.dropTarget() === "",
    listed: state.listings().has(""),
    notice: state.notice(),
    focusRequest: state.focusRequest(),
    filterOpen: state.filterOpen(),
    filterQuery: state.filterQuery(),
    menu: tree.openMenu(),
    confirmation: tree.confirmation(),
  }));
  const { focusRequest, menu, confirmation } = view;
  const scrollKey = `sprockt:${workspace.id}:explorer-scroll`;

  useEffect(() => {
    folderPicker.current?.setAttribute("webkitdirectory", "");
  }, []);

  // Pointer clicks suppress focus rings; the first keyboard press restores them immediately.
  useEffect(() => {
    const clearPointerMode = (event: KeyboardEvent) => {
      if (event.key === "Shift" || event.key === "Control" || event.key === "Meta" || event.key === "Alt") {
        return;
      }
      if (pane.current) delete pane.current.dataset.focusMode;
    };
    window.addEventListener("keydown", clearPointerMode, true);
    return () => window.removeEventListener("keydown", clearPointerMode, true);
  }, []);

  // Zero-jank scroll suppression + sticky ancestor header sync + scrollTop persistence.
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let stickyFrame: number | undefined;

    const markScrolling = () => {
      element.dataset.isScrolling = "";
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        delete element.dataset.isScrolling;
        writeSavedScroll(scrollKey, element.scrollTop);
      }, SCROLL_IDLE_MS);
    };

    const syncSticky = () => {
      stickyFrame = undefined;
      const top = element.scrollTop;
      if (top <= 2) {
        element.dataset.scrollAtTop = "true";
        setSticky((current) => (current.length === 0 ? current : []));
        return;
      }
      delete element.dataset.scrollAtTop;
      const rootHeight = element.querySelector<HTMLElement>(".tree-root")?.offsetHeight ?? 26;
      const firstRow = list.current?.querySelector<HTMLElement>(".row");
      const rowHeight = firstRow?.offsetHeight || 26;
      const entries = state.entries();
      const firstIndex = Math.max(0, Math.floor((top - rootHeight) / rowHeight));
      const next = stickyAncestors(entries, firstIndex, 2);
      setSticky((current) =>
        current.length === next.length && current.every((row, index) => row.path === next[index]?.path)
          ? current
          : next,
      );
    };

    const onScroll = () => {
      markScrolling();
      if (stickyFrame === undefined) stickyFrame = requestAnimationFrame(syncSticky);
    };

    element.dataset.scrollAtTop = "true";
    element.addEventListener("wheel", markScrolling, { passive: true });
    element.addEventListener("touchmove", markScrolling, { passive: true });
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      clearTimeout(idleTimer);
      if (stickyFrame !== undefined) cancelAnimationFrame(stickyFrame);
      element.removeEventListener("wheel", markScrolling);
      element.removeEventListener("touchmove", markScrolling);
      element.removeEventListener("scroll", onScroll);
    };
  }, [scroller, scrollKey, state]);

  // Restore saved scrollTop once initial rows mount.
  useEffect(() => {
    if (scrollRestored.current || !view.listed || view.rows.length === 0) return;
    scrollRestored.current = true;
    const saved = readSavedScroll(scrollKey);
    if (saved > 0 && scroller.current) scroller.current.scrollTop = saved;
  }, [view.listed, view.rows.length, scrollKey, scroller]);

  useEffect(() => {
    if (!focusRequest) return;
    const direct = `[data-path="${CSS.escape(focusRequest.path)}"].row`;
    const element =
      list.current?.querySelector<HTMLElement>(direct) ??
      list.current
        ?.querySelector<HTMLElement>(`[data-segment-path="${CSS.escape(focusRequest.path)}"]`)
        ?.closest<HTMLElement>(".row");
    element?.focus();
    element?.scrollIntoView({ block: "nearest" });
  }, [focusRequest]);

  function dismissFilter(restoreFocus: boolean): void {
    const savedScroll = state.closeFilter();
    if (savedScroll !== undefined && scroller.current) {
      queueMicrotask(() => {
        if (scroller.current) scroller.current.scrollTop = savedScroll;
      });
    }
    if (restoreFocus) {
      const target = state.tabStop();
      if (target) state.focusPath(target);
    }
  }

  function onFilterKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (isComposingEvent(event)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      dismissFilter(true);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      state.moveFocus(event.key, false);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const first = view.entries.find((row) => row.kind === "file") ?? view.entries[0];
      if (!first) return;
      state.select(first.path);
      if (first.kind === "file") actions.store.open(first.path, { focus: true });
      dismissFilter(false);
    }
  }

  return (
    <section
      ref={pane}
      className="pane explorer-pane"
      aria-label={copy.title}
      onPointerDown={() => {
        if (pane.current) pane.current.dataset.focusMode = "pointer";
      }}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
          event.preventDefault();
          event.stopPropagation();
          state.openFilter("", scroller.current?.scrollTop);
          queueMicrotask(() => filterInput.current?.focus());
        }
      }}
    >
      <header className="pane-header explorer-head">
        <span className="pane-title">{copy.title}</span>
        <span className="pane-actions">
          <button
            type="button"
            data-testid="new-file"
            aria-label={copy.actions.newFile}
            title={copy.actions.newFile}
            disabled={!view.writable}
            onClick={() => void state.beginCreate("file")}
          >
            <Icon name="filePlus" />
          </button>
          <button
            type="button"
            data-testid="new-folder"
            aria-label={copy.actions.newFolder}
            title={copy.actions.newFolder}
            disabled={!view.writable}
            onClick={() => void state.beginCreate("directory")}
          >
            <Icon name="folderPlus" />
          </button>
          <button
            type="button"
            data-testid="upload-files"
            aria-label={copy.actions.uploadFiles}
            title={copy.actions.uploadFiles}
            disabled={!view.writable || view.busy === "upload"}
            onClick={() => tree.pick(state.currentTarget().directory, false)}
          >
            <Icon name="upload" />
          </button>
          <button
            type="button"
            data-testid="download-zip"
            aria-label={copy.actions.download}
            title={copy.actions.download}
            disabled={view.busy === "zip"}
            onClick={() => void state.downloadZip()}
          >
            <Icon name="download" />
          </button>
          <button
            type="button"
            data-testid="collapse-all"
            aria-label={copy.actions.collapseAll}
            title={copy.actions.collapseAll}
            onClick={() => state.collapseAll()}
          >
            <Icon name="collapse" />
          </button>
        </span>
      </header>
      {view.filterOpen ? (
        <div className="tree-filter" data-testid="tree-filter">
          <Icon name="search" class="tree-filter-ico" />
          <input
            ref={filterInput}
            type="text"
            className="tree-filter-input"
            data-testid="tree-filter-input"
            aria-label={copy.filterPlaceholder}
            placeholder={copy.filterPlaceholder}
            spellCheck={false}
            autoComplete="off"
            value={view.filterQuery}
            onChange={(event) => state.setFilterQuery(event.currentTarget.value)}
            onKeyDown={onFilterKeyDown}
          />
          <button
            type="button"
            className="tree-filter-clear"
            aria-label={copy.clearFilter}
            onClick={() => dismissFilter(true)}
          >
            <Icon name="close" />
          </button>
        </div>
      ) : null}
      <span id="tree-unsaved" hidden>
        {copy.unsaved}
      </span>
      <input
        ref={filePicker}
        type="file"
        multiple
        hidden
        data-testid="upload-input"
        onChange={(event) => tree.uploaded(event.currentTarget)}
      />
      <input
        ref={folderPicker}
        type="file"
        hidden
        data-testid="upload-folder-input"
        onChange={(event) => tree.uploaded(event.currentTarget)}
      />
      <div
        ref={scroller}
        className={view.rootDrop ? "tree-scroll is-drop-root" : "tree-scroll"}
        // On press, not on click: a click lands on the nearest common ancestor of where the press and
        // the release happened, so a row that moves in between would read as a click on empty space.
        onPointerDown={(event) => {
          const onScrollbar =
            event.clientX >
            event.currentTarget.getBoundingClientRect().left + event.currentTarget.clientWidth;
          if (!onScrollbar && !(event.target as Element).closest(".tree-item, .tree-sticky")) {
            state.clearSelection();
          }
        }}
        onContextMenu={(event) => {
          if (actions.isScrolling()) return;
          event.preventDefault();
          state.openMenu(event, undefined);
        }}
        onDragOver={(event) => actions.dragOver(event, "")}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            tree.stopEdgeScroll();
            state.setDropTarget(undefined);
          }
        }}
        onDrop={(event) => actions.drop(event, "")}
      >
        {sticky.length > 0 && !view.filterOpen ? (
          <div className="tree-sticky" aria-hidden="true">
            {sticky.map((ancestor) => (
              <button
                key={ancestor.path}
                type="button"
                tabIndex={-1}
                className="row is-dir is-open tree-sticky-row"
                style={{ "--depth": ancestor.depth } as React.CSSProperties}
                onClick={() => state.focusPath(ancestor.path)}
              >
                <RowGuides
                  depth={ancestor.depth}
                  ancestorPaths={ancestor.ancestorPaths}
                  activeGuide={undefined}
                />
                <RowIcons row={ancestor} />
                <span className="name">
                  <span className="name-stem">
                    {ancestor.segments ? ancestor.segments.map((s) => s.name).join(" / ") : ancestor.name}
                  </span>
                </span>
              </button>
            ))}
          </div>
        ) : null}
        <div className="tree-root">
          <Icon name="chevronDown" />
          <span>{workspaceName(workspace.id)}</span>
        </div>
        <ul ref={list} className="tree" data-testid="file-tree" aria-label={copy.title}>
          {view.rows.map((row) =>
            row.type === "entry" ? (
              <EntryItem key={row.key} row={row} actions={actions} />
            ) : (
              <DraftItem key={row.key} row={row} actions={actions} />
            ),
          )}
        </ul>
        {view.rows.length === 0 && view.listed ? (
          <p className="tree-empty" data-testid="tree-empty">
            {view.filterOpen && view.filterQuery.trim() ? copy.filterEmpty : copy.empty}
          </p>
        ) : null}
      </div>
      {view.notice ? (
        <p className="tree-notice" role="status" data-testid="tree-notice">
          {view.notice}
        </p>
      ) : null}
      {menu ? (
        <ContextMenu
          key={`${menu.x}:${menu.y}:${menu.path ?? ""}`}
          x={menu.x}
          y={menu.y}
          label={copy.actions.menu}
          items={menu.items}
          onClose={(escaped) => tree.closeMenu(menu, escaped)}
        />
      ) : null}
      {confirmation ? (
        <ConfirmDialog
          title={confirmation.title}
          body={confirmation.body}
          confirm={confirmation.confirm}
          cancel={confirmation.cancel}
          onConfirm={() => void state.confirmDelete()}
          onCancel={() => state.cancelDelete()}
        />
      ) : null}
    </section>
  );
}

export function Explorer(props: { store: EditorStore }) {
  const workspace = useWorkspace();
  const filePicker = useRef<HTMLInputElement>(null);
  const folderPicker = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const filterInput = useRef<HTMLInputElement>(null);
  return (
    <Scope
      create={() =>
        createTree(props.store, workspace, { file: filePicker, folder: folderPicker }, scroller, () =>
          filterInput.current?.focus(),
        )
      }
    >
      {(tree) => (
        <ExplorerBody
          tree={tree}
          filePicker={filePicker}
          folderPicker={folderPicker}
          scroller={scroller}
          filterInput={filterInput}
        />
      )}
    </Scope>
  );
}
