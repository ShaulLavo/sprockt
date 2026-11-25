// Tells the language server about files changed outside the editor (the shell, `bun install`,
// the explorer). tsrs cannot watch files under WASI and applies `workspace/didChangeWatchedFiles`
// without a registration, so the page sends them from Waffle's watch.
import { pathToFileUri, type LanguageServerConnectionContext } from "@singapore-editor/lsp-plugin";
import type { Runtime } from "waffle";
import type { WatchEvent } from "waffle/fs";
import { FilesystemClient } from "waffle/fs/client";
import { fileChangeType, isWatchedPath, projectRelativeName, type FileChangeType } from "./project";

/** How long events are gathered before they are sent: an install changes thousands of files. */
const COALESCE_MS = 100;

interface FileEvent {
  readonly uri: string;
  readonly type: FileChangeType;
}

async function pump(
  client: FilesystemClient,
  signal: AbortSignal,
  onEvents: (events: readonly WatchEvent[]) => void,
): Promise<void> {
  const root = await client.asyncCall("preopen", ["/"]);
  const watch = await client.watch(root, { recursive: true, signal });
  for (;;) {
    // Batches arrive one after another; there is nothing to run in parallel.
    // oxlint-disable-next-line no-await-in-loop
    const batch = await watch.next();
    if (batch.kind === "closed") return;
    // After an overflow the lost events cannot be named; the next ones still are.
    if (batch.kind === "events") onEvents(batch.events);
  }
}

export interface WatchedFiles {
  /** The server (re)started: later changes go to this connection. */
  connected(context: LanguageServerConnectionContext): void;
  stop(): void;
}

export function watchProjectFiles(runtime: Runtime, projectRoot: string): WatchedFiles {
  const lifetime = new AbortController();
  const client = new FilesystemClient(runtime.filesystem.fork());
  const pending = new Map<string, WatchEvent["type"]>();
  let connection: LanguageServerConnectionContext | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function eventFor(path: string, type: WatchEvent["type"]): Promise<FileEvent> {
    const exists = (await runtime.filesystem.lookup(path).catch(() => undefined)) !== undefined;
    return { uri: pathToFileUri(path), type: fileChangeType(type, exists) };
  }

  async function flush(): Promise<void> {
    timer = undefined;
    const batch = Array.from(pending);
    pending.clear();
    if (!connection || lifetime.signal.aborted) return;
    const target = connection;
    const changes = await Promise.all(batch.map(([path, type]) => eventFor(path, type)));
    if (target !== connection || lifetime.signal.aborted) return;
    await target.client.notify("workspace/didChangeWatchedFiles", { changes }).catch(() => {});
  }

  function collect(events: readonly WatchEvent[]): void {
    for (const event of events) {
      const relative = event.name === null ? undefined : projectRelativeName(projectRoot, event.name);
      if (relative === undefined || !isWatchedPath(relative)) continue;
      // A rename wins over a change: whether the file exists decides what it was.
      const path = `${projectRoot}/${relative}`;
      if (pending.get(path) !== "rename") pending.set(path, event.type);
    }
    if (pending.size > 0) timer ??= setTimeout(() => void flush(), COALESCE_MS);
  }

  pump(client, lifetime.signal, collect).catch((error: unknown) => {
    if (!lifetime.signal.aborted) console.error("The language server's file watcher stopped", error);
  });

  return {
    connected: (context) => void (connection = context),
    stop() {
      lifetime.abort();
      clearTimeout(timer);
      client.dispose();
    },
  };
}
