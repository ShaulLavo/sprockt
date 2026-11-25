// The page-side wiring between the Singapore editor and a language server process on Waffle.
// Copied from the LSP lane's verified glue (sprockt-glue.ts, its headless Chromium acceptance
// ran this file unchanged). Differences: Waffle is imported as `waffle` (Sprockt's alias for
// `@waffle-os/runtime`), `openFile` answers whether it opened the file, and the host can
// follow the connection (`onConnected`) to send notifications of its own and restart the
// server (`onStart`) when it has to re-read the disk.
import {
  LspServerExitedError,
  createStdioLspTransport,
  type LspManagedTransport,
} from "@singapore-editor/lsp";
import {
  LspConnectionPool,
  createLanguageServerAdapterPlugin,
  fileUriToPath,
  pathToFileUri,
  type LanguageServerConnectionContext,
  type LanguageServerDefinitionTarget,
  type LanguageServerPlugin,
} from "@singapore-editor/lsp-plugin";
import type { Runtime } from "waffle";
import { startCommand } from "waffle/command";

export type GuestServer = {
  /** The absolute path the server program is installed at. */
  readonly executable: string;
  readonly args: readonly string[];
  /** The workspace directory in the Waffle filesystem. Also the server's root URI. */
  readonly rootPath: string;
  readonly env: Readonly<Record<string, string>>;
};

const STDERR_TAIL_BYTES = 4096;

/** Keeps the end of the server's stderr, for the message shown when it exits. */
function createStderrTail() {
  const decoder = new TextDecoder();
  let text = "";
  return {
    push(bytes: Uint8Array): undefined {
      text = (text + decoder.decode(bytes, { stream: true })).slice(-STDERR_TAIL_BYTES);
    },
    text: () => text,
  };
}

/**
 * Starts the server process and returns the transport of this one run. `onStart` receives the
 * function that kills this run, which the connection then restarts as it would after a crash.
 */
export function connectLanguageServer(
  runtime: Runtime,
  server: GuestServer,
  onStart?: (kill: () => void) => void,
): LspManagedTransport {
  const stderr = createStderrTail();
  const stdio = createStdioLspTransport({ stop: () => void command.kill() });
  const command = startCommand(runtime, server.executable, {
    filesystem: "runtime-root",
    programs: "guest",
    onLeaderExit: "stop",
    args: server.args,
    cwd: server.rootPath,
    env: server.env,
    stdin: stdio.stdin,
    stdout: { limitBytes: 0, onChunk: (bytes) => void stdio.stdout(bytes) },
    stderr: { limitBytes: 0, onChunk: stderr.push },
  });
  void command.result.then(
    ({ exit }) =>
      stdio.exited(
        new LspServerExitedError({
          outcome: exit?.kind ?? "killed",
          exitCode: exit?.kind === "exited" ? exit.code : null,
          exitSignal: exit?.kind === "signaled" ? String(exit.code) : null,
          stderrTail: stderr.text(),
        }),
      ),
    (error: unknown) => stdio.exited(error),
  );
  onStart?.(() => void command.kill());
  return stdio.transport;
}

export type LanguageServerHost = {
  /** Open the file at this absolute Waffle path and select the range. False when it cannot. */
  openFile(path: string, range: LanguageServerDefinitionTarget["range"]): boolean;
  /** The server answered `initialize`; called again after every restart. */
  onConnected?(context: LanguageServerConnectionContext): void;
  /** A server process started; `kill` ends it, and the connection restarts it. */
  onStart?(kill: () => void): void;
};

/** One pool for the page, so a file switch reuses the running server. */
let pool = new LspConnectionPool();

/**
 * Stops every language server now instead of after the pool's 30 s idle grace, for example when
 * the app closes a project. Plugins created afterwards start fresh servers.
 */
export function disposeLanguageServers(): void {
  pool.dispose();
  pool = new LspConnectionPool();
}

export function createGuestLanguageServerPlugin(
  runtime: Runtime,
  name: string,
  server: GuestServer,
  host: LanguageServerHost,
): LanguageServerPlugin {
  return createLanguageServerAdapterPlugin({
    name,
    rootUri: pathToFileUri(server.rootPath),
    createTransport: () => connectLanguageServer(runtime, server, host.onStart),
    reconnect: { delaysMs: [250, 1000, 4000] },
    connectionProvider: pool.provider(`${name}:${server.rootPath}`),
    // Document ids are absolute Waffle paths, mapped to URIs exactly.
    documentSync: {
      uriForDocument: (snapshot) => (snapshot.documentId ? pathToFileUri(snapshot.documentId) : null),
    },
    onConnected: host.onConnected,
    onOpenDefinition(target) {
      const path = fileUriToPath(target.uri);
      if (path === null) return false;
      return host.openFile(path, target.range);
    },
  });
}
