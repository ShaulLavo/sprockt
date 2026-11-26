// The editor slot of the workbench: tabs, the path of the open file, a conflict bar when the file
// changed under unsaved edits, the editor itself, project search beside it, and quick open.
import { detectPlatform, getHotkeyRegistry } from "@shaulavo/hotkeys";
import type { Editor } from "@singapore-editor/core/editor";
import { createEffect, createMemo, For, onCleanup, onMount, Show, type Accessor } from "solid-js";
import type { PaletteCommand } from "../search/commands";
import { QuickOpen } from "../search/QuickOpen";
import { COMMAND } from "../workbench/slots";
import { SearchPanel } from "../search/SearchPanel";
import { AlertIcon, ChevronIcon } from "../search/icons";
import { useWorkspace } from "../workspace/session";
import { EDITOR_COPY } from "./copy";
import "./editor.css";
import { originalPath } from "./buffers";
import { EditorView } from "./EditorView";
import type { EditorStore } from "./store";
import { TabBar } from "./TabBar";

/** The path of the file on screen. */
function Crumbs(props: { path: string | undefined }) {
  const segments = () => props.path?.split("/") ?? [];
  return (
    <nav class="editor-crumbs" aria-label={props.path} data-testid="editor-file">
      <For each={segments()}>
        {(segment, index) => (
          <>
            <Show when={index() > 0}>
              <ChevronIcon />
            </Show>
            <span classList={{ "is-current": index() === segments().length - 1 }}>{segment}</span>
          </>
        )}
      </For>
    </nav>
  );
}

function ConflictBar(props: { store: EditorStore }) {
  const keepMine = () =>
    void props.store.keepMine().catch((error: unknown) => console.error("Saving failed", error));
  const takeTheirs = () =>
    void props.store.takeTheirs().catch((error: unknown) => console.error("Reloading failed", error));
  return (
    <Show when={props.store.conflict()}>
      <div class="editor-conflict" role="alert" data-testid="editor-conflict">
        <AlertIcon />
        <span class="editor-conflict-text">{EDITOR_COPY.externalChangeConflict}</span>
        <button
          type="button"
          class="editor-conflict-action"
          data-testid="conflict-reload"
          onClick={takeTheirs}
        >
          {EDITOR_COPY.reloadFromDisk}
        </button>
        <button
          type="button"
          class="editor-conflict-action is-primary"
          data-testid="conflict-keep"
          onClick={keepMine}
        >
          {EDITOR_COPY.keepMine}
        </button>
      </div>
    </Show>
  );
}

/** Workbench-wide shortcuts, live while the editor pane is mounted. */
function useEditorShortcuts(store: EditorStore, pane: () => HTMLElement, editor: () => Editor | undefined) {
  const save = () => void store.save().catch(reportSaveError);
  onMount(() => {
    const registry = getHotkeyRegistry();
    const options = { preventDefault: true, stopPropagation: true, conflictBehavior: "replace" as const };
    const handles = [
      registry.register("Mod+S", save, options),
      // Ctrl+S saves on a Mac too, as it always has here: macOS binds nothing to it in text fields.
      ...(detectPlatform() === "mac" ? [registry.register("Control+S", save, options)] : []),
      registry.register("Mod+P", () => store.setQuickOpen(true), options),
      registry.register("Mod+Shift+F", () => store.setSearchOpen(true), options),
      // Inside the editor Singapore's find takes Mod+F itself; this covers the tab bar and crumbs.
      registry.register("Mod+F", () => void editor()?.openFind(), { ...options, target: pane() }),
    ];
    onCleanup(() => {
      for (const handle of handles) handle.unregister();
    });
  });

  // Closing or reloading the page with unsaved edits asks first, and autosave starts writing them.
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (store.buffers.dirtyPaths().length === 0) return;
    void store.flushAutosave();
    event.preventDefault();
  };
  window.addEventListener("beforeunload", beforeUnload);
  onCleanup(() => window.removeEventListener("beforeunload", beforeUnload));
}

const reportSaveError = (error: unknown) => console.error("Saving failed", error);

/**
 * Autosave does not wait for the idle pause when the page may go away: a phone that switches apps
 * hides the page and may never show it again.
 */
function useAutosaveTriggers(store: EditorStore) {
  const flush = () => void store.flushAutosave();
  const onVisibility = () => {
    if (document.visibilityState === "hidden") flush();
  };
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", flush);
  onCleanup(() => {
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pagehide", flush);
  });
}

/** Save, Save all and the autosave switch: in the phone menu, and in quick open. */
function useSaveCommands(store: EditorStore): Accessor<readonly PaletteCommand[]> {
  const workspace = useWorkspace();
  const mac = detectPlatform() === "mac";
  const unsavedCount = () => store.buffers.dirtyPaths().length;
  const commands = createMemo((): PaletteCommand[] => [
    {
      id: COMMAND.save,
      label: EDITOR_COPY.save,
      shortcut: mac ? "⌘S" : "Ctrl S",
      run: () => void store.save().catch(reportSaveError),
    },
    {
      id: COMMAND.saveAll,
      label: EDITOR_COPY.saveAll,
      run: () => void store.saveAll().catch(reportSaveError),
    },
    {
      id: COMMAND.autosave,
      label: store.autosave() ? EDITOR_COPY.autosaveOff : EDITOR_COPY.autosaveOn,
      run: () => store.setAutosave(!store.autosave()),
    },
  ]);
  createEffect(() => {
    for (const command of commands()) {
      const icon = command.id === COMMAND.autosave ? "auto" : "save";
      // With autosave off, the phone menu's dot says there is something to save.
      const badge =
        command.id === COMMAND.saveAll ? () => (store.autosave() ? 0 : unsavedCount()) : undefined;
      onCleanup(workspace.commands.register(command.id, { ...command, icon, badge }));
    }
  });
  return commands;
}

export function EditorPane(props: { store: EditorStore }) {
  // A detached draft shows the path it came from.
  const displayedName = () => {
    const path = props.store.displayed();
    return path === undefined ? undefined : originalPath(path);
  };
  const workspace = useWorkspace();
  let pane!: HTMLElement;
  let editor: Editor | undefined;
  useEditorShortcuts(
    props.store,
    () => pane,
    () => editor,
  );
  useAutosaveTriggers(props.store);
  const commands = useSaveCommands(props.store);

  const open = (path: string, location: { line?: number; column?: number }) =>
    props.store.open(path, { ...location, focus: true });

  return (
    <section ref={(node) => (pane = node)} class="pane editor-pane" aria-label={EDITOR_COPY.editor}>
      <div class="editor-shell" classList={{ "has-search": props.store.searchOpen() }}>
        <Show when={props.store.searchOpen()}>
          <SearchPanel
            files={workspace.files}
            focusRequest={props.store.searchFocus}
            onOpen={(path, location) => {
              props.store.open(path, { ...location, preview: true });
              // On a phone the panel covers the editor: get out of the way of the file just opened.
              if (matchMedia("(max-width: 768px)").matches) props.store.setSearchOpen(false);
            }}
            onClose={() => props.store.setSearchOpen(false)}
          />
        </Show>
        <div class="editor-main">
          <TabBar store={props.store} />
          <Crumbs path={displayedName()} />
          <ConflictBar store={props.store} />
          <div class="editor-body">
            <EditorView store={props.store} onEditor={(instance) => (editor = instance)} />
            <Show when={props.store.active() === undefined}>
              <p class="editor-empty" data-testid="editor-empty">
                {EDITOR_COPY.noOpenEditor}
              </p>
            </Show>
          </div>
        </div>
      </div>
      <QuickOpen
        open={props.store.quickOpen}
        files={workspace.files}
        recent={() => props.store.tabs().map((tab) => tab.path)}
        onOpen={open}
        onClose={() => props.store.setQuickOpen(false)}
        commands={commands}
      />
    </section>
  );
}
