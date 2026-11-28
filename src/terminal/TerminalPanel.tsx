// The terminal panel: wraps @shaulavo/workbench/terminal's TerminalPanel over Sprockt's
// Waffle/bash-web session adapter while preserving Sprockt's status telemetry, paste fallback
// notice, diagnostics handle, and phone accessory bar.
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { useViewportMode, type ContextMenuItem } from "@shaulavo/workbench";
import { TerminalPanel as WorkbenchTerminalPanel } from "@shaulavo/workbench/terminal";
import { debugHandle } from "../app/debug";
import { useValue } from "../lib/react";
import type { Accessor } from "../lib/reactive";
import { trackOverflowFade } from "../ui/fade";
import { Icon } from "../ui/icons";
import { useWorkspace } from "../workspace/session";
import { ui } from "./copy";
import { createSprocktTerminalThemeSubscribable, createWaffleTerminalBridge } from "./waffle-adapter";
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

const NOTICE_MS = 4000;

function fadeStrip(element: HTMLDivElement | null): (() => void) | undefined {
  return element ? trackOverflowFade(element) : undefined;
}

export function TerminalPanel(props: TerminalPanelProps) {
  const workspace = useWorkspace();
  const { terminals } = workspace;
  const phone = useViewportMode() === "phone";
  const [notice, setNotice] = useState<string>();
  const noticeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const wantsFocus = useRef<string | undefined>(undefined);
  const openFile = useEffectEvent(
    (path: string, location?: { readonly line?: number; readonly column?: number }) =>
      props.onOpenFile?.(path, location),
  );

  const bridge = useMemo(
    () => createWaffleTerminalBridge(workspace, (path, location) => openFile(path, location)),
    [workspace],
  );
  const themeOverride = useMemo(() => createSprocktTerminalThemeSubscribable(props.scheme), [props.scheme]);

  const view = useValue(() => {
    const tabs = terminals.tabs();
    return { tabs, focusedState: tabs.focused ? terminals.stateOf(tabs.focused) : "exited" };
  });
  const { tabs, focusedState } = view;

  useEffect(() => () => clearTimeout(noticeTimer.current), []);

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

  function showNotice(text: string): void {
    setNotice(text);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(undefined), NOTICE_MS);
  }

  function focusTerminal(id: string | undefined): void {
    if (!id) return;
    const handle = terminals.handle(id);
    if (handle) handle.focus();
    else wantsFocus.current = id;
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

  function closeFocused(): void {
    const focused = terminals.tabs().focused;
    if (focused) terminals.close(focused);
  }

  function extraContextMenuItems(sessionId: string): readonly ContextMenuItem[] {
    return [
      {
        id: "split",
        label: ui.menu.split,
        separatorBefore: true,
        testId: "term-menu-split",
        onSelect: () => toggleSplit(),
      },
      {
        id: "close",
        label: ui.menu.close,
        danger: true,
        testId: "term-menu-close",
        onSelect: () => terminals.close(sessionId),
      },
    ];
  }

  return (
    <div
      className={props.collapsed ? "pane terminal-panel is-collapsed" : "pane terminal-panel"}
      data-testid="terminal-panel"
    >
      <WorkbenchTerminalPanel
        adapter={bridge.adapter}
        active={props.shown}
        collapsed={props.collapsed}
        onToggleCollapsed={props.onToggleCollapsed}
        keepAlive
        splitCreatesSession
        theme={themeOverride}
        fontSize={13}
        mobileFontSize={12}
        backgroundOpacity={1}
        cursorInactiveStyle="auto"
        padding={{ top: 6, right: 6, bottom: 6, left: 14 }}
        showAccessoryBar={phone && props.shown && !props.collapsed}
        stripRef={fadeStrip}
        headerTrailing={
          <>
            <span className="term-state" data-state={focusedState} data-testid="terminal-state">
              {focusedState}
            </span>
            <button
              type="button"
              className="wb-terminal-action-btn term-close-active"
              aria-label={ui.closeActiveTerminal}
              title={ui.closeActiveTerminal}
              disabled={!tabs.focused}
              onClick={closeFocused}
            >
              <Icon name="trash" />
            </button>
          </>
        }
        extraContextMenuItemsForSession={extraContextMenuItems}
        onAttached={(sessionId, terminal) => {
          bridge.bindTerminalHandle(sessionId, terminal);
          if (wantsFocus.current === sessionId) {
            wantsFocus.current = undefined;
            terminal.focus();
          }
        }}
        onTitleChange={(sessionId, title) => terminals.setShellTitle(sessionId, title)}
        onClear={(_sessionId, terminal, attachment) => bridge.clearTerminal(terminal, attachment)}
        onError={(message, cause) => bridge.reportRendererError(message, cause)}
        onPasteFailed={() => showNotice(ui.menu.pasteFallback)}
        renderEmpty={() => (
          <div className="term-empty">
            <p>{ui.noTerminal}</p>
            <button type="button" className="primary" onClick={create}>
              <Icon name="plus" />
              {ui.newTerminal}
            </button>
          </div>
        )}
      />
      {notice ? (
        <p className="term-notice" role="status">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
