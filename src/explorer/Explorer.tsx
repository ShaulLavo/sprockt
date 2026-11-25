import { createEffect, For, on, onCleanup, onMount, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { EditorStore } from "../editor/store";
import { baseName, parentOf, type NameProblem } from "../files/paths";
import { isHeavyName } from "../files/tree";
import { workspaceName } from "../workspace/hint";
import { useWorkspace } from "../workspace/session";
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
  type Row,
} from "./model";
import { createExplorerState, type ExplorerState } from "./state";
import { itemsFromDrop, itemsFromPicker } from "./upload";
import "./explorer.css";

/** Marks a drag that started in the tree, as opposed to files dragged in from the desktop. */
const TREE_DRAG = "application/x-sprockt-paths";
/** How long a dragged item hovers over a closed folder before it opens. */
const HOVER_OPEN_MS = 600;

function NameInput(props: {
  state: ExplorerState;
  initial: string;
  label: string;
  problem: NameProblem | undefined;
}) {
  let input: HTMLInputElement | undefined;
  let settled = false;
  // Whether the person moved on (clicked elsewhere, pressed Tab), as opposed to something else
  // taking focus, such as the editor finishing the load of the file that was just clicked.
  let leftOnPurpose = false;

  const noteLeaving = (event: Event) => {
    if (event.target !== input) leftOnPurpose = true;
  };
  const noteTab = (event: KeyboardEvent) => {
    if (event.key === "Tab") leftOnPurpose = true;
  };

  onMount(() => {
    input?.focus();
    const [start, end] = props.initial ? renameSelection(props.initial) : [0, 0];
    input?.setSelectionRange(start, end);
    document.addEventListener("pointerdown", noteLeaving, true);
    document.addEventListener("keydown", noteTab, true);
  });
  onCleanup(() => {
    document.removeEventListener("pointerdown", noteLeaving, true);
    document.removeEventListener("keydown", noteTab, true);
  });

  async function commit(): Promise<boolean> {
    const accepted = await props.state.commitDraft(input?.value ?? "");
    settled = accepted;
    return accepted;
  }

  function cancel(): void {
    settled = true;
    props.state.cancelDraft();
    const current = props.state.focused();
    if (current) props.state.focusPath(current);
  }

  async function onBlur(): Promise<void> {
    if (settled) return;
    // Focus taken by something else (not the person) must not end the edit: take it back.
    if (!leftOnPurpose) return void queueMicrotask(() => input?.focus());
    // Clicking away keeps a valid name and drops an invalid or unchanged one.
    if (!(await commit())) cancel();
  }

  function onKeyDown(event: KeyboardEvent): void {
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
        ref={(element) => (input = element)}
        class="tree-input"
        classList={{ invalid: props.problem !== undefined }}
        data-testid="tree-input"
        aria-label={props.label}
        aria-invalid={props.problem !== undefined}
        value={props.initial}
        spellcheck={false}
        autocomplete="off"
        autocapitalize="off"
        onInput={() => props.state.setProblem(undefined)}
        onKeyDown={onKeyDown}
        onBlur={() => void onBlur()}
      />
      <Show when={props.problem}>
        {(problem) => (
          <span class="tree-problem" role="alert">
            {copy.problems[problem()]}
          </span>
        )}
      </Show>
    </>
  );
}

interface TreeActions {
  state: ExplorerState;
  store: EditorStore;
  isDirty(path: string): boolean;
  onRowKeyDown(event: KeyboardEvent): void;
  dragStart(event: DragEvent, path: string): void;
  dragEnd(): void;
  dragOver(event: DragEvent, directory: string, closedDirectory?: string): void;
  drop(event: DragEvent, directory: string): void;
}

function EntryItem(props: { row: EntryRow; actions: TreeActions }) {
  const state = () => props.actions.state;
  const path = () => props.row.path;
  const isDirectory = () => props.row.kind === "directory";
  const directoryOfDrop = () => (isDirectory() ? path() : parentOf(path()));
  const dirty = () =>
    isDirectory() ? state().dirtyDirectories().has(path()) : props.actions.isDirty(path());
  const classes = () => ({
    "is-dir": isDirectory(),
    "is-file": !isDirectory(),
    "is-open": props.row.expanded,
    "is-active": props.actions.store.active() === path(),
    "is-selected": state().selected().has(path()),
    "is-dirty": dirty(),
    "is-dim": isHeavyName(props.row.name),
    "is-drop": isDirectory() && state().dropTarget() === path(),
  });

  const rowProps = () => ({
    "data-testid": "tree-row",
    "data-path": path(),
    "data-kind": props.row.kind,
    style: { "--depth": props.row.depth },
  });

  return (
    <li class="tree-item">
      <Show
        when={!props.row.editing}
        fallback={
          <div class="row editing" {...rowProps()}>
            <RowIcons row={props.row} />
            <NameInput
              state={state()}
              initial={props.row.name}
              label={copy.actions.rename}
              problem={state().problem()}
            />
          </div>
        }
      >
        <button
          type="button"
          class="row"
          classList={classes()}
          {...rowProps()}
          tabIndex={state().tabStop() === path() ? 0 : -1}
          aria-expanded={isDirectory() ? props.row.expanded : undefined}
          aria-current={props.actions.store.active() === path() ? "true" : undefined}
          aria-describedby={!isDirectory() && props.actions.isDirty(path()) ? "tree-unsaved" : undefined}
          draggable={state().writable()}
          onFocus={() => state().setFocused(path())}
          onClick={(event) => {
            if (event.shiftKey) return state().select(path(), "range");
            if (event.metaKey || event.ctrlKey) return state().select(path(), "toggle");
            state().select(path());
            if (isDirectory()) state().toggle(path());
            else props.actions.store.open(path());
          }}
          onKeyDown={props.actions.onRowKeyDown}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            state().openMenu(event, path());
          }}
          onDragStart={(event) => props.actions.dragStart(event, path())}
          onDragEnd={() => props.actions.dragEnd()}
          onDragOver={(event) =>
            props.actions.dragOver(event, directoryOfDrop(), isDirectory() ? path() : undefined)
          }
          onDrop={(event) => props.actions.drop(event, directoryOfDrop())}
        >
          <RowIcons row={props.row} />
          <span
            class="name"
            onDblClick={() => {
              // A quick second tap is not a request to rename; touch screens have the menu.
              if (!matchMedia("(pointer: coarse)").matches) state().beginRename(path());
            }}
          >
            {props.row.name}
          </span>
          <Show when={props.row.loading}>
            <span class="tree-spinner" aria-hidden="true" />
          </Show>
          <Show when={!isDirectory() && props.actions.isDirty(path())}>
            <span class="dirty" aria-hidden="true" />
            <span class="git git-m" aria-hidden="true">
              M
            </span>
          </Show>
          <Show when={isDirectory() && dirty()}>
            <span class="git-dot" aria-hidden="true" />
          </Show>
        </button>
        <button
          type="button"
          class="row-more"
          tabIndex={-1}
          aria-label={copy.actions.more}
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            state().openMenu({ clientX: box.left, clientY: box.bottom }, path());
          }}
        >
          <Icon name="more" />
        </button>
      </Show>
    </li>
  );
}

function RowIcons(props: { row: EntryRow }) {
  const kind = () => fileKindOf(props.row.name);
  return (
    <>
      <Show when={props.row.kind === "directory"} fallback={<span class="chev-space" />}>
        <Icon name={props.row.expanded ? "chevronDown" : "chevronRight"} class="chev" />
      </Show>
      <Show
        when={props.row.kind === "directory"}
        fallback={<Icon name={FILE_ICONS[kind().icon]} class={`ft ${kind().tone}`} />}
      >
        <Icon name={props.row.expanded ? "folderOpen" : "folder"} class="ft" />
      </Show>
    </>
  );
}

function DraftItem(props: { row: DraftRow; actions: TreeActions }) {
  return (
    <li class="tree-item">
      <div class="row editing" data-testid="tree-draft" style={{ "--depth": props.row.depth }}>
        <span class="chev-space" />
        <Icon name={props.row.kind === "directory" ? "folder" : "file"} class="ft" />
        <NameInput
          state={props.actions.state}
          initial=""
          label={props.row.kind === "directory" ? copy.actions.newFolder : copy.actions.newFile}
          problem={props.actions.state.problem()}
        />
      </div>
    </li>
  );
}

export function Explorer(props: { store: EditorStore }) {
  const workspace = useWorkspace();
  const files = workspace.files;
  const state = createExplorerState({
    files,
    workspaceId: workspace.id,
    open: (path) => props.store.open(path),
    active: props.store.active,
    hasUnsaved: (path) => props.store.hasUnsaved(path),
    openPaths: () => props.store.tabs().map((tab) => tab.path),
    settle: (paths) => props.store.buffers.settled(paths),
    rename: (from, to) => props.store.rename(from, to),
    close: (path) => props.store.close(path),
  });
  let list: HTMLUListElement | undefined;
  let filePicker: HTMLInputElement | undefined;
  let folderPicker: HTMLInputElement | undefined;
  let uploadDirectory = "";
  let dragged: string[] = [];
  let hoverTimer: { path: string; handle: ReturnType<typeof setTimeout> } | undefined;

  // Rows are rebuilt on every change; reconciling by key keeps the same elements, so focus and
  // an open name box survive a refresh.
  const [rows, setRows] = createStore<Row[]>([]);
  createEffect(() => setRows(reconcile(state.rows(), { key: "key" })));

  createEffect(
    on(props.store.active, (path) => {
      if (path) void state.reveal(path);
    }),
  );

  createEffect(() => {
    const request = state.focusRequest();
    if (!request) return;
    const element = list?.querySelector<HTMLElement>(`[data-path="${CSS.escape(request.path)}"].row`);
    element?.focus();
    element?.scrollIntoView({ block: "nearest" });
  });

  onCleanup(() => clearTimeout(hoverTimer?.handle));

  function pick(directory: string, folder: boolean): void {
    uploadDirectory = directory;
    (folder ? folderPicker : filePicker)?.click();
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

  function onRowKeyDown(event: KeyboardEvent): void {
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

  function dragStart(event: DragEvent, path: string): void {
    dragged = state.selected().has(path) ? Array.from(state.selected()) : [path];
    event.dataTransfer?.setData(TREE_DRAG, JSON.stringify(dragged));
    event.dataTransfer?.setData("text/plain", dragged.map(baseName).join("\n"));
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
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
  function dropEffect(event: DragEvent, directory: string): "move" | "copy" | undefined {
    if (!state.writable()) return undefined;
    if (dragged.length > 0) return canMoveInto(topLevelPaths(dragged), directory) ? "move" : undefined;
    return event.dataTransfer?.types.includes("Files") ? "copy" : undefined;
  }

  function dragOver(event: DragEvent, directory: string, closedDirectory?: string): void {
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

  function drop(event: DragEvent, directory: string): void {
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
    store: props.store,
    isDirty: (path) => props.store.hasUnsaved(path),
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
  const openMenu = () => {
    const menu = state.menu();
    const items = menu ? menuItems(menu.path) : [];
    return menu && items.length > 0 ? { ...menu, items } : undefined;
  };

  const confirmation = () => {
    const paths = state.deleting();
    if (!paths) return undefined;
    const first = paths[0] ?? "";
    if (paths.length > 1)
      return { ...copy.confirmMany, title: fill(copy.confirmMany.title, { count: paths.length }) };
    const text = state.kindOf(first) === "directory" ? copy.confirmFolder : copy.confirmFile;
    return { ...text, title: fill(text.title, { name: baseName(first) }) };
  };

  return (
    <section class="pane explorer-pane" aria-label={copy.title}>
      <header class="pane-header explorer-head">
        <span class="pane-title">{copy.title}</span>
        <span class="pane-actions">
          <button
            type="button"
            data-testid="new-file"
            aria-label={copy.actions.newFile}
            title={copy.actions.newFile}
            disabled={!state.writable()}
            onClick={() => void state.beginCreate("file")}
          >
            <Icon name="filePlus" />
          </button>
          <button
            type="button"
            data-testid="new-folder"
            aria-label={copy.actions.newFolder}
            title={copy.actions.newFolder}
            disabled={!state.writable()}
            onClick={() => void state.beginCreate("directory")}
          >
            <Icon name="folderPlus" />
          </button>
          <button
            type="button"
            data-testid="upload-files"
            aria-label={copy.actions.uploadFiles}
            title={copy.actions.uploadFiles}
            disabled={!state.writable() || state.busy() === "upload"}
            onClick={() => pick(state.currentTarget().directory, false)}
          >
            <Icon name="upload" />
          </button>
          <button
            type="button"
            data-testid="download-zip"
            aria-label={copy.actions.download}
            title={copy.actions.download}
            disabled={state.busy() === "zip"}
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
        ref={(element) => (filePicker = element)}
        type="file"
        multiple
        hidden
        data-testid="upload-input"
        onChange={(event) => uploaded(event.currentTarget)}
      />
      <input
        ref={(element) => {
          folderPicker = element;
          element.setAttribute("webkitdirectory", "");
        }}
        type="file"
        hidden
        data-testid="upload-folder-input"
        onChange={(event) => uploaded(event.currentTarget)}
      />
      <div
        class="tree-scroll"
        classList={{ "is-drop-root": state.dropTarget() === "" }}
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
        onDragOver={(event) => dragOver(event, "")}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            state.setDropTarget(undefined);
        }}
        onDrop={(event) => drop(event, "")}
      >
        <div class="tree-root">
          <Icon name="chevronDown" />
          <span>{workspaceName(workspace.id)}</span>
        </div>
        <ul ref={(element) => (list = element)} class="tree" data-testid="file-tree" aria-label={copy.title}>
          <For each={rows}>
            {(row) =>
              row.type === "entry" ? (
                <EntryItem row={row} actions={actions} />
              ) : (
                <DraftItem row={row} actions={actions} />
              )
            }
          </For>
        </ul>
        <Show when={rows.length === 0 && state.listings().has("")}>
          <p class="tree-empty" data-testid="tree-empty">
            {copy.empty}
          </p>
        </Show>
      </div>
      <Show when={state.notice()}>
        {(text) => (
          <p class="tree-notice" role="status" data-testid="tree-notice">
            {text()}
          </p>
        )}
      </Show>
      <Show when={openMenu()}>
        {(menu) => (
          <ContextMenu
            x={menu().x}
            y={menu().y}
            label={copy.actions.menu}
            items={menu().items}
            onClose={(escaped) => {
              // Read before the menu is cleared: after that its accessor is stale.
              const origin = menu().path ?? state.tabStop();
              state.setMenu(undefined);
              // Escape hands focus back to the row the menu came from.
              if (escaped && origin) state.focusPath(origin);
            }}
          />
        )}
      </Show>
      <Show when={confirmation()}>
        {(text) => (
          <ConfirmDialog
            title={text().title}
            body={text().body}
            confirm={text().confirm}
            cancel={text().cancel}
            onConfirm={() => void state.confirmDelete()}
            onCancel={() => state.cancelDelete()}
          />
        )}
      </Show>
    </section>
  );
}
