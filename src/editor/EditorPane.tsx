// The editor slot of the workbench: tabs, the path of the open file, a conflict bar when the file
// changed under unsaved edits, the editor itself, project search beside it, and quick open.
import {
  createMultiHotkeyHandler,
  detectPlatform,
  getHotkeyRegistry,
  type MultiHotkeyHandler,
} from "@shaulavo/hotkeys";
import type { Editor } from "@singapore-editor/core/editor";
import { Fragment, useCallback, useEffect, useRef, type RefObject } from "react";
import { useScope, useValue } from "../lib/react";
import { createEffect, createMemo, onCleanup, type Accessor } from "../lib/reactive";
import type { PaletteCommand } from "../search/commands";
import { QuickOpen } from "../search/QuickOpen";
import { COMMAND, type Commands } from "../workbench/slots";
import { SearchPanel } from "../search/SearchPanel";
import { AlertIcon, ChevronIcon } from "../search/icons";
import { useWorkspace } from "../workspace/session";
import { EDITOR_COPY } from "./copy";
import "./editor.css";
import { originalPath } from "./buffers";
import { EditorView } from "./EditorView";
import { shouldAutoFocusEditor } from "./focus-policy";
import type { EditorStore } from "./store";
import { adjacentTab } from "./tabs";
import { TabBar } from "./TabBar";
import { UnsavedChangesDialog } from "./UnsavedChangesDialog";

/** The path of the file on screen. */
function Crumbs(props: { path: string | undefined }) {
  const segments = props.path?.split("/") ?? [];
  return (
    <nav className="editor-crumbs" aria-label={props.path} data-testid="editor-file">
      {segments.map((segment, index) => (
        <Fragment key={index}>
          {index > 0 ? <ChevronIcon /> : null}
          <span className={index === segments.length - 1 ? "is-current" : undefined}>{segment}</span>
        </Fragment>
      ))}
    </nav>
  );
}

function ConflictBar(props: { store: EditorStore }) {
  const conflict = useValue(props.store.conflict);
  if (!conflict) return null;
  const keepMine = () =>
    void props.store.keepMine().catch((error: unknown) => console.error("Saving failed", error));
  const takeTheirs = () =>
    void props.store.takeTheirs().catch((error: unknown) => console.error("Reloading failed", error));
  return (
    <div className="editor-conflict" role="alert" data-testid="editor-conflict">
      <AlertIcon />
      <span className="editor-conflict-text">{EDITOR_COPY.externalChangeConflict}</span>
      <button
        type="button"
        className="editor-conflict-action"
        data-testid="conflict-reload"
        onClick={takeTheirs}
      >
        {EDITOR_COPY.reloadFromDisk}
      </button>
      <button
        type="button"
        className="editor-conflict-action is-primary"
        data-testid="conflict-keep"
        onClick={keepMine}
      >
        {EDITOR_COPY.keepMine}
      </button>
    </div>
  );
}

const reportSaveError = (error: unknown) => console.error("Saving failed", error);

/** Workbench-wide shortcuts, live while the editor pane is mounted. */
function useEditorShortcuts(
  store: EditorStore,
  pane: RefObject<HTMLElement | null>,
  editor: RefObject<Editor | undefined>,
) {
  useEffect(() => {
    const save = () => void store.save().catch(reportSaveError);
    const mac = detectPlatform() === "mac";
    const cycleTab = (delta: 1 | -1) => {
      const next = adjacentTab(store.tabs(), store.active(), delta);
      if (next) store.open(next.path, { preview: next.preview, focus: true });
    };
    const closeActiveTab = () => {
      if (store.pendingClose() !== undefined) return;
      const active = store.active();
      if (active) store.requestClose([active]);
    };
    const bindings: MultiHotkeyHandler = {
      "Mod+S": save,
      "Mod+P": () => store.setQuickOpen(true),
      "Mod+Shift+P": () => store.setQuickOpen(true, ">"),
      F1: () => store.setQuickOpen(true, ">"),
      "Mod+Shift+F": () => store.setSearchOpen(true),
      "Alt+W": closeActiveTab,
      ...(mac
        ? {
            // Ctrl+S saves on a Mac too, as it always has here: macOS binds nothing to it in text fields.
            "Control+S": save,
            "Mod+Alt+ArrowLeft": () => cycleTab(-1),
            "Mod+Alt+ArrowRight": () => cycleTab(1),
          }
        : {
            "Control+PageUp": () => cycleTab(-1),
            "Control+PageDown": () => cycleTab(1),
          }),
    };
    // Capture phase ensures workbench shortcuts work even when focus sits inside the Ghostty terminal.
    const onKeyDown = createMultiHotkeyHandler(bindings);
    window.addEventListener("keydown", onKeyDown, true);
    // Inside the editor Singapore's find takes Mod+F itself; this covers the tab bar and crumbs.
    const findHandle = getHotkeyRegistry().register("Mod+F", () => void editor.current?.openFind(), {
      preventDefault: true,
      stopPropagation: true,
      conflictBehavior: "replace",
      target: pane.current ?? undefined,
    });
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      findHandle.unregister();
    };
  }, [store, pane, editor]);

  // Closing or reloading the page with unsaved edits asks first; the text is kept and autosaved.
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (store.buffers.dirtyPaths().length === 0) return;
      void store.pageHidden();
      event.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [store]);
}

/**
 * A phone that switches apps hides the page and may never show it again. Unsaved text is left for
 * recovery at once (a save may have to wait for a lock the page never gets back), and autosave
 * does not wait for the idle pause.
 */
function useAutosaveTriggers(store: EditorStore) {
  useEffect(() => {
    const flush = () => void store.pageHidden();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flush);
    };
  }, [store]);
}

/** Save, Save all and the autosave switch: in the phone menu, and in quick open. Needs a scope. */
function createSaveCommands(store: EditorStore, registry: Commands): Accessor<readonly PaletteCommand[]> {
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
      onCleanup(registry.register(command.id, { ...command, icon, badge }));
    }
  });
  return commands;
}

const EMPTY_COMMANDS: Accessor<readonly PaletteCommand[]> = () => [];
const EMPTY_RECENT: Accessor<readonly string[]> = () => [];

export function EditorPane(props: { store: EditorStore }) {
  const { store } = props;
  const workspace = useWorkspace();
  const pane = useRef<HTMLElement>(null);
  const editor = useRef<Editor>(undefined);
  useEditorShortcuts(store, pane, editor);
  useAutosaveTriggers(store);
  const scope = useScope(() => {
    const saveCommands = createSaveCommands(store, workspace.commands);
    const paletteCommands = createMemo((): readonly PaletteCommand[] => {
      const registered = workspace.commands
        .all()
        .filter(
          (cmd) =>
            cmd.id !== COMMAND.quickOpen &&
            cmd.id !== COMMAND.save &&
            cmd.id !== COMMAND.saveAll &&
            cmd.id !== COMMAND.autosave,
        )
        .map((cmd): PaletteCommand => ({
          id: cmd.id,
          label: cmd.label,
          shortcut: cmd.shortcut,
          run: cmd.run,
        }));
      return saveCommands().concat(registered);
    });
    return {
      commands: paletteCommands,
      // Open tabs, as one list that changes only when the tabs do.
      recent: createMemo(() => store.tabs().map((tab) => tab.path)),
    };
  });
  const commands = scope?.commands ?? EMPTY_COMMANDS;
  const recent = scope?.recent ?? EMPTY_RECENT;
  // A detached draft shows the path it came from.
  const displayedName = useValue(() => {
    const path = store.displayed();
    return path === undefined ? undefined : originalPath(path);
  });
  const searchOpen = useValue(store.searchOpen);
  const pendingClose = useValue(store.pendingClose);
  const quickOpenSeed = useValue(store.quickOpenSeed);
  const onEditor = useCallback((instance: Editor) => {
    editor.current = instance;
  }, []);

  const open = (path: string, location: { line?: number; column?: number }) =>
    store.open(path, { ...location, focus: shouldAutoFocusEditor() });

  return (
    <section ref={pane} className="pane editor-pane" aria-label={EDITOR_COPY.editor}>
      <div className={searchOpen ? "editor-shell has-search" : "editor-shell"}>
        {searchOpen ? (
          <SearchPanel
            files={workspace.files}
            focusRequest={store.searchFocus}
            onOpen={(path, location) => {
              store.open(path, { ...location, preview: true });
              // On a phone the panel covers the editor: get out of the way of the file just opened.
              if (matchMedia("(max-width: 768px)").matches) store.setSearchOpen(false);
            }}
            onClose={() => store.setSearchOpen(false)}
          />
        ) : null}
        <div className="editor-main">
          <TabBar store={store} />
          <Crumbs path={displayedName} />
          <ConflictBar store={store} />
          <div className="editor-body">
            <EditorView store={store} onEditor={onEditor} />
          </div>
        </div>
      </div>
      <QuickOpen
        open={store.quickOpen}
        files={workspace.files}
        recent={recent}
        initialQuery={quickOpenSeed}
        onOpen={open}
        onClose={() => store.setQuickOpen(false)}
        commands={commands}
      />
      {pendingClose && pendingClose.paths.length > 0 ? (
        <UnsavedChangesDialog
          paths={pendingClose.paths}
          saving={pendingClose.saving}
          error={pendingClose.error}
          onSave={() => void store.resolvePendingClose("save").catch(reportSaveError)}
          onDiscard={() => void store.resolvePendingClose("discard")}
          onCancel={() => void store.resolvePendingClose("cancel")}
        />
      ) : null}
    </section>
  );
}
