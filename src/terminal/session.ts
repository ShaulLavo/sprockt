// Joins one Ghostty terminal view to one bash-web shell on the workspace's runtime.
import { BrowserSession, type SessionState } from "bash-web/session";
import { Terminal, type TerminalAppearanceOptions } from "ghostty-webgpu";
import terminalBridge from "ghostty-webgpu/bridge.wasm?url";
import terminalWasm from "ghostty-webgpu/ghostty-vt.wasm?url";
import type { Runtime } from "waffle";
import type { ShellSettings } from "../runtime/boot";
import { TERMINAL_FONT } from "./theme";

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
  /** Sends raw input, as if typed: a soft key such as Escape or an arrow. */
  input(data: string): void;
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
  /** Colors and color scheme; the font is the workbench's code face. */
  readonly appearance: TerminalAppearanceOptions;
  /** Aborted when the tab closes, so a shell still starting stops too. */
  readonly signal: AbortSignal;
  onState(state: SessionState, detail?: string): void;
  onTitle?(title: string): void;
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
  const family = TERMINAL_FONT.family ?? "monospace";
  return document.fonts.load(`${TERMINAL_FONT.size ?? 13}px ${family}`).catch(() => []);
}

/** Ties a started shell to its view. Disposal runs once, and frees the view even if the shell fails to stop. */
function terminalHandle(
  view: Terminal,
  session: BrowserSession,
  start: TerminalStart,
  started: TerminalSize,
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
  const subscriptions = [
    view.onData((event) => typed(event.bytes)),
    view.onResize(({ cols, rows }) => tell(cols, rows)),
    view.onFrame(() => session.markRendered()),
    view.on("title", (title) => start.onTitle?.(title)),
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
  await codeFontReady();
  start.signal.throwIfAborted();
  const view = await Terminal.create({
    accessibility: { label: start.label },
    appearance: { ...start.appearance, font: TERMINAL_FONT },
    padding: PADDING,
    runtime: {
      kind: "owned",
      options: {
        wasm: new URL(terminalWasm, location.href),
        bridge: new URL(terminalBridge, location.href),
      },
    },
  });
  try {
    await view.open(start.host);
    start.signal.throwIfAborted();
    followPaneLayout(view, start.signal);
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
    return terminalHandle(view, session, start, { columns: geometry.columns, rows: geometry.rows });
  } catch (error) {
    view.dispose();
    throw error;
  }
}
