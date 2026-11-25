// Tells the language server about files changed outside the editor (the shell, `bun install`,
// the explorer). tsrs cannot watch files under WASI and applies `workspace/didChangeWatchedFiles`
// without a registration, so the page sends them from Waffle's watch. When the watch may have
// lost events (it overflowed and was registered again), the server is restarted instead, so it
// re-reads the disk; the editor re-opens its documents with their unsaved text.
import { pathToFileUri, type LanguageServerConnectionContext } from "@singapore-editor/lsp-plugin";
import type { Runtime } from "waffle";
import { watchFilesystemEvents, type WatchEvent } from "../files/watch";
import { fileChangeType, isWatchedPath, projectRelativeName, type FileChangeType } from "./project";
import { createRestartScheduler } from "./restart";

/** How long events are gathered before they are sent: an install changes thousands of files. */
const COALESCE_MS = 100;

interface FileEvent {
  readonly uri: string;
  readonly type: FileChangeType;
}

export interface WatchedFiles {
  /** The server (re)started: later changes go to this connection. */
  connected(context: LanguageServerConnectionContext): void;
  /** A server process started; `kill` is how a resync restarts it. */
  started(kill: () => void): void;
  stop(): void;
}

export function watchProjectFiles(runtime: Runtime, projectRoot: string): WatchedFiles {
  const pending = new Map<string, WatchEvent["type"]>();
  let connection: LanguageServerConnectionContext | undefined;
  let kill: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const restarts = createRestartScheduler(() => kill?.());

  async function eventFor(path: string, type: WatchEvent["type"]): Promise<FileEvent> {
    const exists = (await runtime.filesystem.lookup(path).catch(() => undefined)) !== undefined;
    return { uri: pathToFileUri(path), type: fileChangeType(type, exists) };
  }

  async function flush(): Promise<void> {
    timer = undefined;
    const batch = Array.from(pending);
    pending.clear();
    if (!connection || stopped) return;
    const target = connection;
    const changes = await Promise.all(batch.map(([path, type]) => eventFor(path, type)));
    if (target !== connection || stopped) return;
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

  const unwatch = watchFilesystemEvents(runtime, (update) => {
    if (update !== "resync") return collect(update);
    // What was gathered is incomplete; the restarted server reads everything anyway.
    pending.clear();
    restarts.request();
  });

  return {
    connected: (context) => void (connection = context),
    started: (killServer) => void (kill = killServer),
    stop() {
      stopped = true;
      unwatch();
      restarts.stop();
      clearTimeout(timer);
    },
  };
}
