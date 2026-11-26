import { memo, useEffect, useRef, type RefObject } from "react";
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

/** `base` plus every flag that is on, as one class attribute. */
function classes(base: string, flags: Readonly<Record<string, boolean>>): string {
  return [base].concat(Object.keys(flags).filter((name) => flags[name])).join(" ");
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

interface TreeActions {
  state: ExplorerState;
  store: EditorStore;
  isDirty(path: string): boolean;
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
  const directoryOfDrop = isDirectory ? path : parentOf(path);
  const live = useValue(() => ({
    active: store.active() === path,
    selected: state.selected().has(path),
    fileDirty: !isDirectory && actions.isDirty(path),
    folderDirty: isDirectory && state.dirtyDirectories().has(path),
    drop: isDirectory && state.dropTarget() === path,
    tabStop: state.tabStop() === path,
    writable: state.writable(),
    problem: row.editing ? state.problem() : undefined,
  }));

  const rowProps = {
    "data-testid": "tree-row",
    "data-path": path,
    "data-kind": row.kind,
    style: { "--depth": row.depth } as React.CSSProperties,
  };

  if (row.editing) {
    return (
      <li className="tree-item">
        <div className="row editing" {...rowProps}>
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
    "is-dim": isHeavyName(row.name),
    "is-drop": live.drop,
  });

  return (
    <li className="tree-item">
      <button
        type="button"
        className={className}
        {...rowProps}
        tabIndex={live.tabStop ? 0 : -1}
        aria-expanded={isDirectory ? row.expanded : undefined}
        aria-current={live.active ? "true" : undefined}
        aria-describedby={live.fileDirty ? "tree-unsaved" : undefined}
        draggable={live.writable}
        onFocus={() => state.setFocused(path)}
        onClick={(event) => {
          if (event.shiftKey) return state.select(path, "range");
          if (event.metaKey || event.ctrlKey) return state.select(path, "toggle");
          state.select(path);
          if (isDirectory) state.toggle(path);
          else store.open(path);
        }}
        onKeyDown={actions.onRowKeyDown}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          state.openMenu(event, path);
        }}
        onDragStart={(event) => actions.dragStart(event, path)}
        onDragEnd={() => actions.dragEnd()}
        onDragOver={(event) => actions.dragOver(event, directoryOfDrop, isDirectory ? path : undefined)}
        onDrop={(event) => actions.drop(event, directoryOfDrop)}
      >
        <RowIcons row={row} />
        <span
          className="name"
          onDoubleClick={() => {
            // A quick second tap is not a request to rename; touch screens have the menu.
            if (!matchMedia("(pointer: coarse)").matches) state.beginRename(path);
          }}
        >
          {row.name}
        </span>
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

/** Rows are rebuilt on every change; a row whose fields are all the same does not render again. */
function sameEntry(previous: EntryItemProps, next: EntryItemProps): boolean {
  if (previous.actions !== next.actions) return false;
  const keys = Object.keys(next.row) as (keyof EntryRow)[];
  return (
    keys.length === Object.keys(previous.row).length &&
    keys.every((key) => previous.row[key] === next.row[key])
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
  return (
    <li className="tree-item">
      <div
        className="row editing"
        data-testid="tree-draft"
        style={{ "--depth": props.row.depth } as React.CSSProperties}
      >
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
function createTree(store: EditorStore, workspace: WorkspaceSession, pickers: Pickers) {
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

  createEffect(
    on(store.active, (path) => {
      if (path) void state.reveal(path);
    }),
  );

  onCleanup(() => clearTimeout(hoverTimer?.handle));

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
    if (focused && !state.selected().has(focused)) return [focused];
    return chosen.length > 0 ? chosen : focused ? [focused] : [];
  }

  function onRowKeyDown(event: React.KeyboardEvent<HTMLElement>): void {
    if (event.altKey || event.target instanceof HTMLInputElement) return;
    const arrow = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"] as const;
    const key = arrow.find((name) => name === event.key);
    if (key && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      state.moveFocus(key, event.shiftKey);
      return;
    }
    const focused = state.focused();
    if (event.key === "F2" && focused) {
      event.preventDefault();
      state.beginRename(focused);
    }
    if (event.key === "Delete" || (event.key === "Backspace" && event.metaKey)) {
      event.preventDefault();
      void state.requestDelete(selectionOrFocus());
    }
    if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      event.preventDefault();
      const box = (event.target as HTMLElement).getBoundingClientRect();
      state.openMenu({ clientX: box.left + 24, clientY: box.bottom }, focused);
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

  return { state, actions, pick, uploaded, openMenu, closeMenu, confirmation };
}

function ExplorerBody(props: {
  tree: ReturnType<typeof createTree>;
  filePicker: RefObject<HTMLInputElement | null>;
  folderPicker: RefObject<HTMLInputElement | null>;
}) {
  const { tree, filePicker, folderPicker } = props;
  const workspace = useWorkspace();
  const list = useRef<HTMLUListElement>(null);
  const { state, actions } = tree;
  const view = useValue(() => ({
    rows: state.rows(),
    writable: state.writable(),
    busy: state.busy(),
    rootDrop: state.dropTarget() === "",
    listed: state.listings().has(""),
    notice: state.notice(),
    focusRequest: state.focusRequest(),
    menu: tree.openMenu(),
    confirmation: tree.confirmation(),
  }));
  const { focusRequest, menu, confirmation } = view;

  useEffect(() => {
    folderPicker.current?.setAttribute("webkitdirectory", "");
  }, []);

  useEffect(() => {
    if (!focusRequest) return;
    const selector = `[data-path="${CSS.escape(focusRequest.path)}"].row`;
    const element = list.current?.querySelector<HTMLElement>(selector);
    element?.focus();
    element?.scrollIntoView({ block: "nearest" });
  }, [focusRequest]);

  return (
    <section className="pane explorer-pane" aria-label={copy.title}>
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
        className={view.rootDrop ? "tree-scroll is-drop-root" : "tree-scroll"}
        // On press, not on click: a click lands on the nearest common ancestor of where the press and
        // the release happened, so a row that moves in between would read as a click on empty space.
        onPointerDown={(event) => {
          const onScrollbar =
            event.clientX >
            event.currentTarget.getBoundingClientRect().left + event.currentTarget.clientWidth;
          if (!onScrollbar && !(event.target as Element).closest(".tree-item")) state.clearSelection();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          state.openMenu(event, undefined);
        }}
        onDragOver={(event) => actions.dragOver(event, "")}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            state.setDropTarget(undefined);
        }}
        onDrop={(event) => actions.drop(event, "")}
      >
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
            {copy.empty}
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
  return (
    <Scope create={() => createTree(props.store, workspace, { file: filePicker, folder: folderPicker })}>
      {(tree) => <ExplorerBody tree={tree} filePicker={filePicker} folderPicker={folderPicker} />}
    </Scope>
  );
}
