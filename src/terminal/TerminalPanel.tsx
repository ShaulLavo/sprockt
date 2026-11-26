// The terminal panel: a strip of terminal tabs (new, rename, close, switch, split) over the
// shown terminal or a split pair, and on phones a row of keys a touch keyboard lacks.
import { createMemo, createSignal, For, onCleanup, onMount, Show, type Accessor } from "solid-js";
import { debugHandle } from "../app/debug";
import { Icon } from "../ui/icons";
import { fill } from "../ui/format";
import { trackOverflowFade } from "../ui/fade";
import { terminalTabTone } from "../ui/tab-colors";
import { useWorkspace } from "../workspace/session";
import { ui } from "./copy";
import type { SessionState } from "./session";
import type { TerminalStore } from "./store";
import type { TerminalTab } from "./tabs";
import { TerminalKeys } from "./TerminalKeys";
import { TerminalView, type ViewPosition } from "./TerminalView";
import "./terminal.css";

export interface TerminalPanelProps {
  readonly scheme: Accessor<"light" | "dark">;
  /** Collapsed shows only the tab strip. */
  readonly collapsed: boolean;
  /** False while another pane fills a phone screen. */
  readonly shown: boolean;
  onToggleCollapsed(): void;
}

function TabIndicator(props: { state: SessionState }) {
  return (
    <Show
      when={props.state === "running" || props.state === "failed" || props.state === "exited"}
      fallback={<Icon name="terminal" />}
    >
      <span class="ttab-dot" data-state={props.state} aria-hidden="true" />
    </Show>
  );
}

function RenameField(props: { tab: TerminalTab; onDone(title: string | undefined): void }) {
  let input: HTMLInputElement | undefined;
  onMount(() => {
    input?.focus();
    input?.select();
  });
  return (
    <input
      ref={(element) => (input = element)}
      class="ttab-rename"
      value={props.tab.title}
      aria-label={fill(ui.renameTerminal, { name: props.tab.title })}
      spellcheck={false}
      autocomplete="off"
      enterkeyhint="done"
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") props.onDone(event.currentTarget.value);
        if (event.key === "Escape") props.onDone(undefined);
      }}
      onBlur={(event) => props.onDone(event.currentTarget.value)}
    />
  );
}

function Tab(props: {
  tab: TerminalTab;
  index: number;
  store: TerminalStore;
  onSelect(id: string): void;
  onKey(event: KeyboardEvent, id: string): void;
  renaming: boolean;
  onRename(id: string | undefined): void;
}) {
  const state = () => props.store.tabs();
  const shown = () => state().active === props.tab.id || state().split === props.tab.id;
  const focused = () => state().focused === props.tab.id;
  return (
    <div
      class="ttab"
      classList={{ "is-active": focused(), "is-shown": shown() }}
      data-tab-tone={terminalTabTone(props.tab.title, props.index)}
    >
      <Show
        when={props.renaming}
        fallback={
          <button
            type="button"
            role="tab"
            class="ttab-main"
            id={`terminal-tab-${props.tab.id}`}
            aria-selected={focused()}
            tabindex={focused() ? 0 : -1}
            data-testid="terminal-tab"
            onClick={() => props.onSelect(props.tab.id)}
            onDblClick={() => props.onRename(props.tab.id)}
            onKeyDown={(event) => props.onKey(event, props.tab.id)}
          >
            <TabIndicator state={props.store.stateOf(props.tab.id)} />
            <span class="ttab-title">{props.tab.title}</span>
          </button>
        }
      >
        <RenameField
          tab={props.tab}
          onDone={(title) => {
            if (title !== undefined) props.store.rename(props.tab.id, title);
            props.onRename(undefined);
          }}
        />
      </Show>
      <button
        type="button"
        class="ttab-close"
        tabindex="-1"
        aria-label={fill(ui.closeTerminal, { name: props.tab.title })}
        onClick={() => props.store.close(props.tab.id)}
      >
        <Icon name="x" />
      </button>
    </div>
  );
}

export function TerminalPanel(props: TerminalPanelProps) {
  const { terminals } = useWorkspace();
  const [renaming, setRenaming] = createSignal<string>();
  const ids = createMemo(() => terminals.tabs().tabs.map((tab) => tab.id), [], {
    equals: (a, b) => a.length === b.length && a.every((id, index) => id === b[index]),
  });
  const tabById = (id: string) => terminals.tabs().tabs.find((tab) => tab.id === id);
  const focusedState = () => {
    const focused = terminals.tabs().focused;
    return focused ? terminals.stateOf(focused) : "exited";
  };
  let wantsFocus: string | undefined;
  let strip: HTMLDivElement | undefined;

  debugHandle().terminalLines = () => {
    const focused = terminals.tabs().focused;
    return (focused && terminals.handle(focused)?.lines()) || [];
  };

  debugHandle().terminalSize = () => {
    const focused = terminals.tabs().focused;
    return focused ? terminals.handle(focused)?.size() : undefined;
  };

  onMount(() => strip && onCleanup(trackOverflowFade(strip)));

  function focusTerminal(id: string | undefined): void {
    if (!id) return;
    const handle = terminals.handle(id);
    if (handle) handle.focus();
    else wantsFocus = id;
  }

  function onAttached(id: string): void {
    if (wantsFocus !== id) return;
    wantsFocus = undefined;
    terminals.handle(id)?.focus();
  }

  function select(id: string): void {
    terminals.select(id);
    if (props.collapsed) props.onToggleCollapsed();
    focusTerminal(id);
  }

  function create(): void {
    const id = terminals.create();
    if (props.collapsed) props.onToggleCollapsed();
    focusTerminal(id);
  }

  function toggleSplit(): void {
    terminals.toggleSplit();
    if (props.collapsed) props.onToggleCollapsed();
    focusTerminal(terminals.tabs().focused);
  }

  function kill(): void {
    const focused = terminals.tabs().focused;
    if (focused) terminals.close(focused);
  }

  function onTabKey(event: KeyboardEvent, id: string): void {
    if (event.key === "F2") {
      event.preventDefault();
      setRenaming(id);
      return;
    }
    if (event.key === "Delete") {
      event.preventDefault();
      terminals.close(id);
      return;
    }
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    terminals.cycle(event.key === "ArrowRight" ? 1 : -1);
    const next = terminals.tabs().focused;
    if (next) document.getElementById(`terminal-tab-${next}`)?.focus();
  }

  function positionOf(id: string): ViewPosition {
    const { active, split } = terminals.tabs();
    if (id === active) return split ? "left" : "single";
    if (id === split) return "right";
    return "hidden";
  }

  return (
    <section
      class="pane terminal-panel"
      classList={{ "is-collapsed": props.collapsed }}
      aria-label={ui.terminal}
      data-testid="terminal-panel"
    >
      <div class="term-bar">
        <div class="term-tabs" role="tablist" aria-label={ui.tabs} ref={(element) => (strip = element)}>
          <For each={ids()}>
            {(id, index) => (
              <Show when={tabById(id)}>
                {(tab) => (
                  <Tab
                    tab={tab()}
                    index={index()}
                    store={terminals}
                    onSelect={select}
                    onKey={onTabKey}
                    renaming={renaming() === id}
                    onRename={setRenaming}
                  />
                )}
              </Show>
            )}
          </For>
        </div>
        <button
          type="button"
          class="icon-button term-add"
          aria-label={ui.newTerminal}
          title={ui.newTerminal}
          data-testid="new-terminal"
          onClick={create}
        >
          <Icon name="plus" />
        </button>
        <span class="term-fill" />
        <span class="term-state" data-state={focusedState()} data-testid="terminal-state">
          {focusedState()}
        </span>
        <div class="term-actions">
          <button
            type="button"
            class="icon-button term-split"
            aria-label={terminals.tabs().split ? ui.unsplitTerminal : ui.splitTerminal}
            title={terminals.tabs().split ? ui.unsplitTerminal : ui.splitTerminal}
            aria-pressed={Boolean(terminals.tabs().split)}
            onClick={toggleSplit}
          >
            <Icon name="split" />
          </button>
          <button
            type="button"
            class="icon-button"
            aria-label={ui.closeActiveTerminal}
            title={ui.closeActiveTerminal}
            disabled={!terminals.tabs().focused}
            onClick={kill}
          >
            <Icon name="trash" />
          </button>
          <button
            type="button"
            class="icon-button term-collapse"
            aria-label={props.collapsed ? ui.expandPanel : ui.collapsePanel}
            title={props.collapsed ? ui.expandPanel : ui.collapsePanel}
            aria-expanded={!props.collapsed}
            onClick={() => props.onToggleCollapsed()}
          >
            <Icon name={props.collapsed ? "chev-u" : "chev-d"} />
          </button>
        </div>
      </div>
      <div
        class="terminal-host"
        data-split={terminals.tabs().split ? "" : undefined}
        onClick={() => focusTerminal(terminals.tabs().focused)}
      >
        <For each={ids()}>
          {(id) => (
            <TerminalView
              id={id}
              position={positionOf(id)}
              scheme={props.scheme}
              label={tabById(id)?.title ?? ui.terminal}
              onAttached={onAttached}
            />
          )}
        </For>
        <Show when={ids().length === 0}>
          <div class="term-empty">
            <p>{ui.noTerminal}</p>
            <button type="button" class="primary" onClick={create}>
              <Icon name="plus" />
              {ui.newTerminal}
            </button>
          </div>
        </Show>
      </div>
      <TerminalKeys
        handle={() => terminals.handle(terminals.tabs().focused ?? "")}
        shown={props.shown && !props.collapsed}
      />
    </section>
  );
}
