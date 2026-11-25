// Joins one Ghostty terminal view to one bash-web shell on the workspace's runtime.
import { BrowserSession, type SessionState } from "bash-web/session";
import { Terminal } from "ghostty-webgpu";
import terminalBridge from "ghostty-webgpu/bridge.wasm?url";
import terminalWasm from "ghostty-webgpu/ghostty-vt.wasm?url";
import type { Runtime } from "waffle";
import type { ShellSettings } from "../runtime/boot";

export type { SessionState };

export interface TerminalHandle {
  /** The text on screen, one string per row, for tests and diagnostics. */
  lines(): string[];
  focus(): void;
  dispose(): Promise<void>;
}

export interface TerminalStart {
  readonly host: HTMLElement;
  readonly runtime: Runtime;
  readonly shell: ShellSettings;
  readonly label: string;
  onState(state: SessionState, detail?: string): void;
}

export async function startTerminal(start: TerminalStart): Promise<TerminalHandle> {
  const view = await Terminal.create({
    accessibility: { label: start.label },
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
    const geometry = view.geometry();
    const session = await BrowserSession.create({
      runtime: start.runtime,
      wasmUrl: start.shell.wasmUrl,
      workerUrl: start.shell.workerUrl,
      cwd: start.shell.cwd,
      env: { ...start.shell.env },
      cols: geometry.columns,
      rows: geometry.rows,
      onOutput: (bytes) => view.write(bytes),
      onState: (state, detail) => start.onState(state, detail),
    });
    const subscriptions = [
      view.onData((event) => session.input(event.bytes)),
      view.onResize(({ cols, rows }) => session.resize(cols, rows)),
      view.onFrame(() => session.markRendered()),
    ];
    return {
      lines: () => view.visibleLines().map((line) => line.trimEnd()),
      focus: () => view.focus(),
      async dispose() {
        for (const subscription of subscriptions) subscription.dispose();
        await session.dispose();
        view.dispose();
      },
    };
  } catch (error) {
    view.dispose();
    throw error;
  }
}
