// Adapts Sprockt's Waffle + bash-web TerminalStore and CSS light-dark() tokens onto
// @shaulavo/workbench/core's TerminalAdapter and @shaulavo/workbench/terminal's TerminalThemeInput.
import { BrowserSession } from "bash-web/session";
import type {
  Subscribable,
  TerminalAdapter,
  TerminalAttachment,
  TerminalSessionInfo,
  TerminalSessionStatus,
} from "@shaulavo/workbench/core";
import type { TerminalThemeInput } from "@shaulavo/workbench/terminal";
import { parseCssColor, type RgbColor } from "@shaulavo/workbench/tokens";
import type { Terminal } from "ghostty-webgpu";
import { createEffect, createRoot, type Accessor } from "../lib/reactive";
import { PROJECT_ROOT, projectRelative } from "../workspace/paths";
import type { WorkspaceSession } from "../workspace/session";
import type { SessionState, TerminalHandle, TerminalSize } from "./session";

const ANSI_TOKENS = [
  "--ansi-black",
  "--ansi-red",
  "--ansi-green",
  "--ansi-yellow",
  "--ansi-blue",
  "--ansi-magenta",
  "--ansi-cyan",
  "--ansi-white",
  "--ansi-bright-black",
  "--ansi-bright-red",
  "--ansi-bright-green",
  "--ansi-bright-yellow",
  "--ansi-bright-blue",
  "--ansi-bright-magenta",
  "--ansi-bright-cyan",
  "--ansi-bright-white",
] as const;

const FONT_FAMILY =
  '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace';
const FALLBACK_BLACK: RgbColor = { r: 0, g: 0, b: 0 };

export function createReactiveSubscribable<T>(
  read: () => T,
  equals: (a: T, b: T) => boolean = Object.is,
): Subscribable<T> {
  let snapshot = read();
  // Track the last notified value separately from `snapshot`: synchronous `getSnapshot()` reads
  // (for example when a sibling subscribable notifies first inside `flushEffects()`) must never
  // advance the notification baseline and swallow `useSyncExternalStore` updates.
  let lastNotified = snapshot;
  const listeners = new Set<() => void>();
  let stopEffect: (() => void) | undefined;

  function ensureRunning(): void {
    if (stopEffect) return;
    lastNotified = snapshot;
    stopEffect = createRoot((dispose) => {
      createEffect(() => {
        const next = read();
        if (!equals(snapshot, next)) snapshot = next;
        if (equals(lastNotified, snapshot)) return;
        lastNotified = snapshot;
        for (const listener of Array.from(listeners)) listener();
      });
      return dispose;
    });
  }

  return {
    getSnapshot() {
      const next = read();
      if (!equals(snapshot, next)) snapshot = next;
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      ensureRunning();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && stopEffect) {
          stopEffect();
          stopEffect = undefined;
        }
      };
    },
  };
}

function sameSplitPair(
  a: readonly [string, string] | undefined,
  b: readonly [string, string] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a[0] === b[0] && a[1] === b[1];
}

function mapSessionStatus(state: SessionState): TerminalSessionStatus {
  return state;
}

function sameSessions(a: readonly TerminalSessionInfo[], b: readonly TerminalSessionInfo[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (!left || !right) return false;
    if (left.id !== right.id || left.title !== right.title || left.status !== right.status) return false;
  }
  return true;
}

/**
 * Resolves Sprockt's terminal CSS tokens via a hidden probe on `<body>`/`<html>` rather than
 * inside the terminal host, because a hidden mobile pane (`display: none`) skips style
 * recalculation in WebKit/Safari and would otherwise return stale `light-dark()` colors.
 */
export function readSprocktTerminalTheme(scheme: "light" | "dark"): TerminalThemeInput {
  const probe = document.createElement("span");
  probe.style.cssText =
    "position:fixed;visibility:hidden;pointer-events:none;width:0;height:0;overflow:hidden;";
  probe.style.colorScheme = scheme;
  (document.body ?? document.documentElement).append(probe);
  const style = getComputedStyle(probe);
  const read = (token: string): RgbColor => {
    probe.style.color = `var(${token})`;
    return parseCssColor(style.color) ?? FALLBACK_BLACK;
  };
  const background = read("--term-bg");
  const theme: TerminalThemeInput = {
    colorScheme: scheme,
    background,
    foreground: read("--ansi-fg"),
    cursor: read("--term-cursor"),
    cursorAccent: background,
    selectionBackground: read("--bg-selection"),
    selectionForeground: read("--fg"),
    ansi: ANSI_TOKENS.map(read),
    backgroundOpacity: 1,
    fontFamily: FONT_FAMILY,
    lineHeight: 1.15,
  };
  probe.remove();
  return theme;
}

export function createSprocktTerminalThemeSubscribable(
  scheme: Accessor<"light" | "dark">,
): Subscribable<TerminalThemeInput> {
  let lastScheme = scheme();
  let lastNotifiedScheme = lastScheme;
  let cached = readSprocktTerminalTheme(lastScheme);
  const listeners = new Set<() => void>();
  let stopEffect: (() => void) | undefined;

  function syncTheme(): void {
    const nextScheme = scheme();
    if (nextScheme !== lastScheme) {
      lastScheme = nextScheme;
      cached = readSprocktTerminalTheme(nextScheme);
    }
    if (nextScheme === lastNotifiedScheme) return;
    lastNotifiedScheme = nextScheme;
    for (const listener of Array.from(listeners)) listener();
  }

  return {
    getSnapshot() {
      const currentScheme = scheme();
      if (currentScheme !== lastScheme) {
        lastScheme = currentScheme;
        cached = readSprocktTerminalTheme(currentScheme);
      }
      return cached;
    },
    subscribe(listener) {
      listeners.add(listener);
      if (!stopEffect) {
        lastNotifiedScheme = lastScheme;
        stopEffect = createRoot((dispose) => {
          createEffect(() => {
            scheme();
            syncTheme();
          });
          return dispose;
        });
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && stopEffect) {
          stopEffect();
          stopEffect = undefined;
        }
      };
    },
  };
}

interface AttachedSessionRecord {
  readonly browserSession: BrowserSession;
  readonly getToldSize: () => TerminalSize;
}

export interface WaffleTerminalBridge {
  readonly adapter: TerminalAdapter;
  bindTerminalHandle(sessionId: string, terminal: Terminal): void;
  clearTerminal(terminal: Terminal, attachment: TerminalAttachment | null): void;
}

function clearTerminal(terminal: Terminal, attachment: TerminalAttachment | null): void {
  terminal.clearSelection();
  terminal.write("\x1b[3J\x1b[2J\x1b[H");
  attachment?.write("\x0c");
  terminal.focus();
}

/** Normalizes a terminal file link candidate (`./foo`, `/workspace/foo`, `foo`) to a project-relative path. */
export function normalizeTerminalLinkPath(raw: string): string | undefined {
  let path = raw;
  if (path.startsWith(`${PROJECT_ROOT}/`)) {
    const rel = projectRelative(path);
    if (!rel) return undefined;
    path = rel;
  } else if (path.startsWith("/")) {
    return undefined;
  }
  while (path.startsWith("./")) path = path.slice(2);
  if (!path || path.endsWith("/") || path.includes("\0")) return undefined;
  const badSegment = path.split("/").find((seg) => seg === "" || seg === "." || seg === "..");
  if (badSegment !== undefined) return undefined;
  return path;
}

export function createWaffleTerminalBridge(
  workspace: WorkspaceSession,
  onOpenFile?: (path: string, location?: { readonly line?: number; readonly column?: number }) => void,
): WaffleTerminalBridge {
  const { terminals } = workspace;
  const attached = new Map<string, AttachedSessionRecord>();

  const sessions = createReactiveSubscribable<readonly TerminalSessionInfo[]>(() => {
    const { tabs } = terminals.tabs();
    return tabs.map((tab) => ({
      id: tab.id,
      title: tab.title,
      status: mapSessionStatus(terminals.stateOf(tab.id)),
    }));
  }, sameSessions);

  const activeId = createReactiveSubscribable<string | undefined>(() => terminals.tabs().focused);
  const splitId = createReactiveSubscribable<string | undefined>(() => terminals.tabs().split);
  const splitPair = createReactiveSubscribable<readonly [string, string] | undefined>(() => {
    const { active, split } = terminals.tabs();
    return active && split ? [active, split] : undefined;
  }, sameSplitPair);

  function runStartupCommand(sessionId: string, browserSession: BrowserSession): void {
    if (terminals.stateOf(sessionId) !== "ready") return;
    const command = terminals.takeCommand(sessionId);
    if (command) {
      void browserSession.submit(command).catch(() => {});
    }
  }

  const adapter: TerminalAdapter = {
    sessions,
    activeId,
    splitId,
    splitPair,
    async createSession(options) {
      return terminals.create(options?.title ? { title: options.title } : undefined);
    },
    async closeSession(id) {
      terminals.close(id);
    },
    selectSession(id) {
      terminals.select(id);
    },
    renameSession(id, title) {
      terminals.rename(id, title);
    },
    toggleSplit() {
      terminals.toggleSplit();
    },
    async resolveFileLink(rawPath) {
      const normalized = normalizeTerminalLinkPath(rawPath);
      if (!normalized) return null;
      return (await workspace.files.size(normalized)) !== undefined ? normalized : null;
    },
    openFileLink(resolvedPath, location) {
      onOpenFile?.(resolvedPath, location);
    },
    async attach(sessionId, { initialSize, signal, onEvent }) {
      let told: TerminalSize = { columns: initialSize.cols, rows: initialSize.rows };
      let liveSession: BrowserSession | undefined;

      const browserSession = await BrowserSession.create({
        runtime: workspace.runtime,
        wasmUrl: workspace.shell.wasmUrl,
        workerUrl: workspace.shell.workerUrl,
        cwd: workspace.shell.cwd,
        env: { ...workspace.shell.env },
        cols: initialSize.cols,
        rows: initialSize.rows,
        signal,
        onOutput: (bytes) => {
          terminals.emitOutput(sessionId, bytes);
          onEvent({ type: "output", data: bytes });
        },
        onState: (state, detail) => {
          if (signal.aborted) return;
          terminals.setState(sessionId, state);
          if (state === "failed" && detail) {
            onEvent({ type: "error", message: detail });
          }
          if (liveSession) runStartupCommand(sessionId, liveSession);
        },
      });
      if (signal.aborted) {
        void browserSession.dispose().catch(() => {});
        return { write: () => {}, resize: () => {}, detach: () => {} };
      }

      liveSession = browserSession;
      attached.set(sessionId, { browserSession, getToldSize: () => told });
      runStartupCommand(sessionId, browserSession);

      // bash-web has no historical replay stream; open ReplayGate immediately after creation.
      onEvent({ type: "ready" });
      onEvent({ type: "replay-complete" });

      let disposed = false;
      const disposeSession = (): void => {
        if (disposed) return;
        disposed = true;
        attached.delete(sessionId);
        terminals.attach(sessionId, undefined);
        void browserSession.dispose().catch(() => {});
      };

      const attachment: TerminalAttachment = {
        write(data) {
          browserSession.input(data);
        },
        writeBytes(bytes) {
          browserSession.input(bytes);
        },
        resize(cols, rows) {
          if (cols === told.columns && rows === told.rows) return;
          told = { columns: cols, rows };
          browserSession.resize(cols, rows);
        },
        markRendered() {
          browserSession.markRendered();
        },
        detach: disposeSession,
      };
      return attachment;
    },
  };

  function bindTerminalHandle(sessionId: string, terminal: Terminal): void {
    const record = attached.get(sessionId);
    if (!record) return;
    const { browserSession, getToldSize } = record;
    let disposal: Promise<void> | undefined;
    const handle: TerminalHandle = {
      lines: () => terminal.visibleLines().map((line) => line.trimEnd()),
      size: () => {
        const { columns, rows } = terminal.geometry();
        return { screen: { columns, rows }, shell: getToldSize() };
      },
      focus: () => terminal.focus(),
      submit: (command) => browserSession.submit(command),
      input: (data) => browserSession.input(data),
      interrupt: () => browserSession.interrupt(),
      isRunning: () => browserSession.running,
      clear() {
        terminal.clearSelection();
        terminal.write("\x1b[3J\x1b[2J\x1b[H");
        browserSession.input("\x0c");
      },
      getSelection: () => terminal.getSelection(),
      paste: (text) => void terminal.paste(text),
      dispose: () => (disposal ??= browserSession.dispose().catch(() => {})),
    };
    terminals.attach(sessionId, handle);
  }

  return { adapter, bindTerminalHandle, clearTerminal };
}
