// The terminal panel: a strip of terminal tabs (new, rename, close, switch, split) over the
// shown terminal or a split pair, and on phones a row of keys a touch keyboard lacks.
import { useEffect, useRef, useState } from "react";
import type React from "react";
import { debugHandle } from "../app/debug";
import { useValue } from "../lib/react";
import type { Accessor } from "../lib/reactive";
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
  onOpenFile?(path: string, location?: { readonly line?: number; readonly column?: number }): void;
}

function TabIndicator(props: { state: SessionState }) {
  if (props.state !== "running" && props.state !== "failed" && props.state !== "exited") {
    return <Icon name="terminal" />;
  }
  return <span className="ttab-dot" data-state={props.state} aria-hidden="true" />;
}

function RenameField(props: { tab: TerminalTab; onDone(title: string | undefined): void }) {
  const input = useRef<HTMLInputElement>(null);
  const settled = useRef(false);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  function finish(title: string | undefined): void {
    if (settled.current) return;
    settled.current = true;
    props.onDone(title);
  }
  return (
    <input
      ref={input}
      className="ttab-rename"
      defaultValue={props.tab.title}
      aria-label={fill(ui.renameTerminal, { name: props.tab.title })}
      spellCheck={false}
      autoComplete="off"
      enterKeyHint="done"
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Enter") {
          event.preventDefault();
          finish(event.currentTarget.value);
        }
        if (event.key === "Escape") {
          event.preventDefault();
          finish(undefined);
        }
      }}
      onBlur={(event) => finish(event.currentTarget.value)}
    />
  );
}

function Tab(props: {
  tab: TerminalTab;
  index: number;
  store: TerminalStore;
  /** The tab has keyboard focus in the strip. */
  focused: boolean;
  /** The tab's terminal is on screen, alone or in a split. */
  shown: boolean;
  onSelect(id: string): void;
  onKey(event: React.KeyboardEvent, id: string): void;
  renaming: boolean;
  onRename(id: string | undefined): void;
}) {
  const { tab, store } = props;
  const sessionState = useValue(() => store.stateOf(tab.id));
  const className = ["ttab"]
    .concat(props.focused ? ["is-active"] : [], props.shown ? ["is-shown"] : [])
    .join(" ");
  return (
    <div className={className} data-tab-tone={terminalTabTone(tab.title, props.index)}>
      {props.renaming ? (
        <RenameField
          tab={tab}
          onDone={(title) => {
            if (title !== undefined) store.rename(tab.id, title);
            props.onRename(undefined);
          }}
        />
      ) : (
        <button
          type="button"
          role="tab"
          className="ttab-main"
          id={`terminal-tab-${tab.id}`}
          aria-selected={props.focused}
          tabIndex={props.focused ? 0 : -1}
          data-testid="terminal-tab"
          onClick={() => props.onSelect(tab.id)}
          onDoubleClick={() => props.onRename(tab.id)}
          onKeyDown={(event) => props.onKey(event, tab.id)}
        >
          <TabIndicator state={sessionState} />
          <span className="ttab-title">{tab.title}</span>
        </button>
      )}
      <button
        type="button"
        className="ttab-close"
        tabIndex={-1}
        aria-label={fill(ui.closeTerminal, { name: tab.title })}
        onClick={() => store.close(tab.id)}
      >
        <Icon name="x" />
      </button>
    </div>
  );
}

export function TerminalPanel(props: TerminalPanelProps) {
  const { terminals } = useWorkspace();
  const [renaming, setRenaming] = useState<string>();
  const view = useValue(() => {
    const tabs = terminals.tabs();
    return { tabs, focusedState: tabs.focused ? terminals.stateOf(tabs.focused) : "exited" };
  });
  const { tabs, focusedState } = view;
  const wantsFocus = useRef<string | undefined>(undefined);
  const strip = useRef<HTMLDivElement>(null);

  useEffect(() => {
    debugHandle().terminalLines = () => {
      const focused = terminals.tabs().focused;
      return (focused && terminals.handle(focused)?.lines()) || [];
    };
    debugHandle().terminalSize = () => {
      const focused = terminals.tabs().focused;
      return focused ? terminals.handle(focused)?.size() : undefined;
    };
  }, [terminals]);

  useEffect(() => (strip.current ? trackOverflowFade(strip.current) : undefined), []);

  function focusTerminal(id: string | undefined): void {
    if (!id) return;
    const handle = terminals.handle(id);
    if (handle) handle.focus();
    else wantsFocus.current = id;
  }

  function onAttached(id: string): void {
    if (wantsFocus.current !== id) return;
    wantsFocus.current = undefined;
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

  function onTabKey(event: React.KeyboardEvent, id: string): void {
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
    const { active, split } = tabs;
    if (id === active) return split ? "left" : "single";
    if (id === split) return "right";
    return "hidden";
  }

  return (
    <section
      className={props.collapsed ? "pane terminal-panel is-collapsed" : "pane terminal-panel"}
      aria-label={ui.terminal}
      data-testid="terminal-panel"
    >
      <div className="term-bar">
        <div className="term-tabs" role="tablist" aria-label={ui.tabs} ref={strip}>
          {tabs.tabs.map((tab, index) => (
            <Tab
              key={tab.id}
              tab={tab}
              index={index}
              store={terminals}
              focused={tabs.focused === tab.id}
              shown={tabs.active === tab.id || tabs.split === tab.id}
              onSelect={select}
              onKey={onTabKey}
              renaming={renaming === tab.id}
              onRename={setRenaming}
            />
          ))}
        </div>
        <button
          type="button"
          className="icon-button term-add"
          aria-label={ui.newTerminal}
          title={ui.newTerminal}
          data-testid="new-terminal"
          onClick={create}
        >
          <Icon name="plus" />
        </button>
        <span className="term-fill" />
        <span className="term-state" data-state={focusedState} data-testid="terminal-state">
          {focusedState}
        </span>
        <div className="term-actions">
          <button
            type="button"
            className="icon-button term-split"
            aria-label={tabs.split ? ui.unsplitTerminal : ui.splitTerminal}
            title={tabs.split ? ui.unsplitTerminal : ui.splitTerminal}
            aria-pressed={Boolean(tabs.split)}
            onClick={toggleSplit}
          >
            <Icon name="split" />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={ui.closeActiveTerminal}
            title={ui.closeActiveTerminal}
            disabled={!tabs.focused}
            onClick={kill}
          >
            <Icon name="trash" />
          </button>
          <button
            type="button"
            className="icon-button term-collapse"
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
        className="terminal-host"
        data-split={tabs.split ? "" : undefined}
        onClick={() => focusTerminal(terminals.tabs().focused)}
      >
        {tabs.tabs.map((tab) => (
          <TerminalView
            key={tab.id}
            id={tab.id}
            position={positionOf(tab.id)}
            scheme={props.scheme}
            label={tab.title}
            onAttached={onAttached}
            onOpenFile={props.onOpenFile}
            onSplit={toggleSplit}
            onClose={() => terminals.close(tab.id)}
          />
        ))}
        {tabs.tabs.length === 0 ? (
          <div className="term-empty">
            <p>{ui.noTerminal}</p>
            <button type="button" className="primary" onClick={create}>
              <Icon name="plus" />
              {ui.newTerminal}
            </button>
          </div>
        ) : null}
      </div>
      <TerminalKeys
        handle={() => terminals.handle(terminals.tabs().focused ?? "")}
        shown={props.shown && !props.collapsed}
      />
    </section>
  );
}
