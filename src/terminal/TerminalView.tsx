// One terminal tab's screen: starts its shell on mount, stops it on unmount, follows the
// workbench theme & viewport font breakpoint, and hosts a capture-phase context menu.
import { useEffect, useEffectEvent, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { ContextMenu, type MenuItem } from "../explorer/ContextMenu";
import { useValue } from "../lib/react";
import type { Accessor } from "../lib/reactive";
import { useWorkspace, type WorkspaceSession } from "../workspace/session";
import { ui } from "./copy";
import { startTerminal, type TerminalHandle } from "./session";
import { isPhoneViewport, terminalAppearance } from "./theme";

export type ViewPosition = "single" | "left" | "right" | "hidden";

export interface TerminalViewProps {
  readonly id: string;
  readonly position: ViewPosition;
  /** True when this terminal is currently visible on screen (not hidden behind another mobile pane/tab). */
  readonly visible: boolean;
  readonly scheme: Accessor<"light" | "dark">;
  readonly label: string;
  /** Called once the shell has started, so the panel can focus it if the user asked to. */
  onAttached(id: string): void;
  onOpenFile?(path: string, location?: { readonly line?: number; readonly column?: number }): void;
  onSplit?(): void;
  onClose?(): void;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const NOTICE_MS = 4000;

interface MountOptions {
  readonly id: string;
  readonly label: string;
  getScheme(): "light" | "dark";
  getPhone(): boolean;
  readonly session: Pick<WorkspaceSession, "terminals" | "runtime" | "shell" | "files">;
  /** Holds the started shell for the theme effect. */
  readonly handle: { current: TerminalHandle | undefined };
  setFailure(text: string): void;
  onAttached(id: string): void;
  onOpenFile?(path: string, location?: { readonly line?: number; readonly column?: number }): void;
}

/**
 * Starts one shell on `host` and returns what stops it. Stopping is idempotent: the first call
 * aborts a start still in flight, detaches the shell from the store and frees its screen.
 */
function mountTerminal(host: HTMLDivElement, options: MountOptions): () => void {
  const { id, session } = options;
  const { terminals } = session;
  const closing = new AbortController();

  /** Failures after the tab closed are the closing itself, not something to show. */
  function report(error: unknown): void {
    if (closing.signal.aborted) return;
    options.setFailure(message(error));
  }

  function runStartupCommand(): void {
    const handle = options.handle.current;
    if (!handle || terminals.stateOf(id) !== "ready") return;
    const command = terminals.takeCommand(id);
    if (command) handle.submit(command).catch(report);
  }

  async function open(): Promise<void> {
    const started = await startTerminal({
      host,
      runtime: session.runtime,
      shell: session.shell,
      label: options.label,
      appearance: terminalAppearance(host, options.getScheme(), options.getPhone()),
      signal: closing.signal,
      onState(state, detail) {
        if (closing.signal.aborted) return;
        terminals.setState(id, state);
        if (state === "failed") options.setFailure(detail ?? ui.shellStopped);
        runStartupCommand();
      },
      onTitle: (title) => terminals.setShellTitle(id, title),
      fileExists: async (path) => (await session.files.size(path)) !== undefined,
      openFile: options.onOpenFile,
    });
    if (closing.signal.aborted) return started.dispose();
    options.handle.current = started;
    // Re-sync appearance after async startup in case the theme or viewport changed mid-boot.
    started.setAppearance(terminalAppearance(host, options.getScheme(), options.getPhone()));
    terminals.attach(id, started);
    runStartupCommand();
    options.onAttached(id);
  }

  open().catch((error: unknown) => {
    if (closing.signal.aborted) return;
    terminals.setState(id, "failed");
    report(error);
  });

  return () => {
    if (closing.signal.aborted) return;
    closing.abort(new Error("The terminal tab was closed."));
    terminals.attach(id, undefined);
    const handle = options.handle.current;
    options.handle.current = undefined;
    // The view is freed even when the shell fails to stop, and a closed tab has nowhere to
    // show that failure.
    handle?.dispose().catch(() => {});
  };
}

interface ContextState {
  readonly x: number;
  readonly y: number;
  readonly selection: string | undefined;
}

export function TerminalView(props: TerminalViewProps) {
  const session = useWorkspace();
  const { terminals } = session;
  const [failure, setFailure] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [menu, setMenu] = useState<ContextState>();
  const [phone, setPhone] = useState(isPhoneViewport);
  const phoneRef = useRef(phone);
  phoneRef.current = phone;
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<TerminalHandle | undefined>(undefined);
  const noticeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const scheme = useValue(props.scheme);
  const attached = useEffectEvent((id: string) => props.onAttached(id));
  const openFile = useEffectEvent(
    (path: string, location?: { readonly line?: number; readonly column?: number }) =>
      props.onOpenFile?.(path, location),
  );

  useEffect(() => {
    const media = matchMedia("(max-width: 768px)");
    const update = () => setPhone(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  // One shell per mount. The id is the view's key, and the label is the starting value:
  // renames and theme changes reach a running shell through their own effects.
  useEffect(() => {
    if (!host.current) return;
    return mountTerminal(host.current, {
      id: props.id,
      label: props.label,
      getScheme: () => props.scheme(),
      getPhone: () => phoneRef.current,
      session,
      handle,
      setFailure,
      onAttached: attached,
      onOpenFile: openFile,
    });
  }, []);

  useEffect(() => {
    if (host.current) handle.current?.setAppearance(terminalAppearance(host.current, scheme, phone));
  }, [scheme, phone, props.visible]);

  function showNotice(text: string): void {
    setNotice(text);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(undefined), NOTICE_MS);
  }

  // Capture-phase contextmenu snapshots the current selection before Ghostty's target-phase
  // handler parks the hidden textarea or a menu click clears the selection.
  function onContextMenuCapture(event: ReactMouseEvent<HTMLDivElement>): void {
    event.preventDefault();
    event.stopPropagation();
    terminals.select(props.id);
    setMenu({ x: event.clientX, y: event.clientY, selection: handle.current?.getSelection() });
  }

  function menuItems(current: ContextState): MenuItem[] {
    const items: MenuItem[] = [];
    if (current.selection) {
      const selectedText = current.selection;
      items.push({
        label: ui.menu.copy,
        testId: "term-menu-copy",
        run: () => {
          void navigator.clipboard?.writeText(selectedText).catch(() => {});
          handle.current?.focus();
        },
      });
    }
    items.push(
      {
        label: ui.menu.paste,
        testId: "term-menu-paste",
        run: () => {
          if (!navigator.clipboard?.readText) {
            showNotice(ui.menu.pasteFallback);
            handle.current?.focus();
            return;
          }
          void (async () => {
            try {
              const text = await navigator.clipboard.readText();
              if (text) handle.current?.paste(text);
            } catch {
              showNotice(ui.menu.pasteFallback);
            }
            handle.current?.focus();
          })();
        },
      },
      {
        label: ui.menu.clear,
        testId: "term-menu-clear",
        run: () => {
          handle.current?.clear();
          handle.current?.focus();
        },
      },
    );
    if (props.onSplit) {
      const split = props.onSplit;
      items.push({
        label: ui.menu.split,
        testId: "term-menu-split",
        run: () => split(),
      });
    }
    if (props.onClose) {
      const close = props.onClose;
      items.push({
        label: ui.menu.close,
        danger: true,
        testId: "term-menu-close",
        run: () => close(),
      });
    }
    return items;
  }

  return (
    <div
      className="term-view"
      data-position={props.position}
      data-terminal={props.id}
      onPointerDown={() => terminals.select(props.id)}
      onContextMenuCapture={onContextMenuCapture}
    >
      <div className="term-canvas" ref={host} />
      {failure ? <p className="pane-error term-failure">{failure}</p> : null}
      {notice ? (
        <p className="term-notice" role="status">
          {notice}
        </p>
      ) : null}
      {menu ? (
        <ContextMenu
          key={`${menu.x}:${menu.y}`}
          x={menu.x}
          y={menu.y}
          label={ui.menu.label}
          items={menuItems(menu)}
          onClose={(escaped) => {
            setMenu(undefined);
            if (escaped) handle.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}
