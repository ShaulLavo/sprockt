// Shared handle and geometry types bridging Waffle bash-web shells with Sprockt's TerminalStore
// and diagnostics (debugHandle.terminalLines / terminalSize).
import type { SessionState } from "bash-web/session";

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
  /** Sends raw input, as if typed. */
  input(data: string): void;
  /** Clears the terminal viewport and scrollback. */
  clear(): void;
  /** Currently selected text in the terminal, if any. */
  getSelection(): string | undefined;
  /** Pastes text through Ghostty's bracketed-paste encoder. */
  paste(text: string): void;
  dispose(): Promise<void>;
}
