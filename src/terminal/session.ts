// Joins one Ghostty terminal view to one bash-web shell on the workspace's runtime.
import { BrowserSession, type SessionState } from "bash-web/session";
import { Terminal, type TerminalAppearanceOptions } from "ghostty-webgpu";
import { attachTerminalHotkeys } from "ghostty-webgpu/hotkeys";
import type { Runtime } from "waffle";
import type { ShellSettings } from "../runtime/boot";
import { createWorkspaceLinkProvider, safeExternalUrl } from "./links";
import { getSharedGhosttyRuntime } from "./runtime";
import { terminalFont } from "./theme";

export type { SessionState };

/** A terminal's size in character cells. */
export interface TerminalSize {
  readonly columns: number;
  readonly rows: number;
}

export interface TerminalHandle {
  /** The text on screen, one string per row, for tests and diagnostics. */
  lines(): string[];
  /** The screen's size and the size the shell was last told, for tests and diagnostics. */
  size(): { readonly screen: TerminalSize; readonly shell: TerminalSize };
  focus(): void;
  /** Types a command line and presses Enter, replacing anything half typed. */
  submit(command: string): Promise<void>;
  /** Sends raw input, as if typed: a soft key such as Ctrl+C or a symbol. */
  input(data: string): void;
  /**
   * Dispatches a hardware KeyboardEvent to Ghostty's textarea so terminal modes like DECCKM
   * (application cursor keys in vim/less/fzf) encode the key properly.
   */
  pressKey(key: string, code: string, fallbackData: string): void;
  /** Clears the terminal viewport and scrollback. */
  clear(): void;
  /** Currently selected text in the terminal, if any. */
  getSelection(): string | undefined;
  /** Pastes text through Ghostty's bracketed-paste encoder. */
  paste(text: string): void;
  /**
   * Turns the next typed letter into its Control chord (a phone keyboard has no Ctrl key).
   * `onUsed` runs when that letter arrives.
   */
  armControl(onUsed: () => void): void;
  disarmControl(): void;
  setAppearance(appearance: TerminalAppearanceOptions): void;
  dispose(): Promise<void>;
}

export interface TerminalStart {
  readonly host: HTMLElement;
  readonly runtime: Runtime;
  readonly shell: ShellSettings;
  readonly label: string;
  /** Colors, color scheme, and responsive font; the font is the workbench's code face. */
  readonly appearance: TerminalAppearanceOptions;
  /** Aborted when the tab closes, so a shell still starting stops too. */
  readonly signal: AbortSignal;
  onState(state: SessionState, detail?: string): void;
  onTitle?(title: string): void;
  fileExists?(path: string): Promise<boolean>;
  openFile?(path: string, location?: { readonly line?: number; readonly column?: number }): void;
}

/** The Control chord of one typed letter or `@[\]^_`, such as Ctrl+C for "c"; else undefined. */
export function controlChord(bytes: Uint8Array): Uint8Array | undefined {
  const byte = bytes.length === 1 ? bytes[0] : undefined;
  if (byte === undefined) return undefined;
  const upper = byte >= 0x61 && byte <= 0x7a ? byte - 0x20 : byte;
  if (upper < 0x40 || upper > 0x5f) return undefined;
  return Uint8Array.of(upper & 0x1f);
}

/** Room around the text, so it does not touch the panel's rounded edges. */
const PADDING = { top: 6, right: 6, bottom: 6, left: 14 };

/**
 * Waits for the code face before the terminal measures its cells. Ghostty refits when a font
 * loads later, but starting with the right metrics avoids one visible reflow.
 */
function codeFontReady(): Promise<unknown> {
  const font = terminalFont();
  const family = font.family ?? "monospace";
  return document.fonts.load(`${font.size ?? 13}px ${family}`).catch(() => []);
}

/** Ties a started shell to its view. Disposal runs once, and frees the view even if the shell fails to stop. */
function terminalHandle(
  view: Terminal,
  session: BrowserSession,
  start: TerminalStart,
  started: TerminalSize,
  extraDisposables: readonly { dispose(): void }[],
): TerminalHandle {
  // The size the shell believes its screen has. Every change of the screen's own size is
  // passed on, so programs lay their output out for the columns actually on screen.
  let told = started;
  const tell = (columns: number, rows: number) => {
    if (columns === told.columns && rows === told.rows) return;
    told = { columns, rows };
    session.resize(columns, rows);
  };
  const screen = (): TerminalSize => {
    const { columns, rows } = view.geometry();
    return { columns, rows };
  };
  let control: (() => void) | undefined;
  const typed = (bytes: Uint8Array) => {
    const chord = control && controlChord(bytes);
    if (!chord) return session.input(bytes);
    const used = control;
    control = undefined;
    session.input(chord);
    used?.();
  };
  const subscriptions: { dispose(): void }[] = [
    view.onData((event) => typed(event.bytes)),
    view.onResize(({ cols, rows }) => tell(cols, rows)),
    view.onFrame(() => session.markRendered()),
    view.on("title", (title) => start.onTitle?.(title)),
    ...extraDisposables,
  ];
  // The screen may have been refitted while the shell was starting, before anything listened:
  // its pane came on screen (a phone starts with the terminal hidden), or the code face loaded.
  const now = screen();
  tell(now.columns, now.rows);
  let disposal: Promise<void> | undefined;
  async function dispose(): Promise<void> {
    for (const subscription of subscriptions) subscription.dispose();
    try {
      await session.dispose();
    } finally {
      view.dispose();
    }
  }
  return {
    lines: () => view.visibleLines().map((line) => line.trimEnd()),
    size: () => ({ screen: screen(), shell: told }),
    focus: () => view.focus(),
    submit: (command) => session.submit(command),
    input: (data) => session.input(data),
    pressKey(key, code, fallbackData) {
      const target = view.textarea;
      if (!target) return session.input(fallbackData);
      const down = new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true });
      target.dispatchEvent(down);
      target.dispatchEvent(new KeyboardEvent("keyup", { key, code, bubbles: true, cancelable: true }));
    },
    clear() {
      view.clearSelection();
      view.write("\x1b[3J\x1b[2J\x1b[H");
      session.input("\x0c");
    },
    getSelection: () => view.getSelection(),
    paste: (text) => void view.paste(text),
    armControl: (onUsed) => void (control = onUsed),
    disarmControl: () => void (control = undefined),
    setAppearance: (appearance) => void view.setAppearance(appearance),
    dispose: () => (disposal ??= dispose()),
  };
}

/**
 * Where several panes share the screen, one has the keyboard at a time, and a terminal without
 * it shows a hollow cursor. On a phone the terminal is the only pane on screen, so its cursor
 * stays solid: nothing else could be taking the keys.
 */
function followPaneLayout(view: Terminal, signal: AbortSignal): void {
  const sharedScreen = matchMedia("(min-width: 769px)");
  const apply = () => void view.setCursorInactiveStyle(sharedScreen.matches ? "outline" : undefined);
  apply();
  sharedScreen.addEventListener("change", apply, { signal });
}

/** Starts a terminal; aborting `start.signal` cancels a start still in progress. */
export async function startTerminal(start: TerminalStart): Promise<TerminalHandle> {
  const [, sharedRuntime] = await Promise.all([codeFontReady(), getSharedGhosttyRuntime()]);
  start.signal.throwIfAborted();
  const view = await Terminal.create({
    accessibility: { label: start.label },
    appearance: { font: terminalFont(), ...start.appearance },
    padding: PADDING,
    links: {
      activateUri: (uri) => {
        const safe = safeExternalUrl(uri);
        if (safe) window.open(safe, "_blank", "noopener,noreferrer");
      },
    },
    runtime: {
      kind: "borrowed",
      runtime: sharedRuntime,
    },
  });
  const extraDisposables: { dispose(): void }[] = [];
  try {
    await view.open(start.host);
    start.signal.throwIfAborted();
    followPaneLayout(view, start.signal);
    extraDisposables.push(attachTerminalHotkeys(view, { mode: "standalone" }));
    if (start.fileExists && start.openFile) {
      extraDisposables.push(
        view.registerLinkProvider(
          createWorkspaceLinkProvider({ exists: start.fileExists, openFile: start.openFile }),
        ),
      );
    }
    const geometry = view.geometry();
    const session = await BrowserSession.create({
      runtime: start.runtime,
      wasmUrl: start.shell.wasmUrl,
      workerUrl: start.shell.workerUrl,
      cwd: start.shell.cwd,
      env: { ...start.shell.env },
      cols: geometry.columns,
      rows: geometry.rows,
      signal: start.signal,
      onOutput: (bytes) => view.write(bytes),
      onState: (state, detail) => start.onState(state, detail),
    });
    return terminalHandle(
      view,
      session,
      start,
      { columns: geometry.columns, rows: geometry.rows },
      extraDisposables,
    );
  } catch (error) {
    for (const disposable of extraDisposables) disposable.dispose();
    view.dispose();
    throw error;
  }
}
