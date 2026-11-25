// Watches the workspace filesystem from the page, so the IDE follows changes made by the shell,
// by Bun, or by another tab attached to the same workspace.
//
// A watch can end without us asking: the filesystem service restarts, the host tab fails over,
// or it overflows. Overflow is terminal in Waffle: the subscription never delivers another path
// ("After overflow, close all subscriptions, reconcile the consumer's view, and register again",
// Waffle docs/filesystem-watch.md). So the loop closes the old watch, registers a new one with a
// growing pause, and only then asks the listener to resync, so nothing between the old watch's
// end and the new one's start is missed. (Same recovery as bun-wasm's
// `web/src/workspace-watch.ts`, and the file-tree slice's draft of this file.)
import type { Runtime } from "waffle";
import type { WatchBatch, WatchEvent } from "waffle/fs";
import { FilesystemClient } from "waffle/fs/client";

export type { WatchEvent };

/**
 * Either the next events, or `"resync"`: events may have been lost, so the listener reconciles
 * its view with what is on disk now.
 */
export type WatchUpdate = readonly WatchEvent[] | "resync";

/** One open watch on the whole filesystem. `next` resolves with the next batch of events. */
export interface WatchSession {
  next(): Promise<WatchBatch>;
  close(): void;
}

export interface WatchLoopOptions {
  open(signal: AbortSignal): Promise<WatchSession>;
  onUpdate(update: WatchUpdate): void;
  signal: AbortSignal;
  /**
   * Also resync after the first open, for a listener that takes its first inventory only once
   * the watch is registered and so misses nothing in between.
   */
  resyncOnFirstOpen?: boolean;
  /** Pauses between reopen attempts; the last one repeats. */
  backoffMs?: readonly number[];
  /** Waits `ms`, or until the signal aborts. Tests replace it to see the delays. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const BACKOFF_MS = [100, 250, 500, 1000, 2000] as const;

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/**
 * Pumps one session until it ends. True when it delivered events and ended in a normal close
 * (it was healthy, so the next pause starts over). An overflow is not healthy: a watch that keeps
 * overflowing keeps backing off instead of resyncing every 100 ms. A throw is left for the
 * caller's backoff.
 */
async function pump(session: WatchSession, options: WatchLoopOptions): Promise<boolean> {
  let delivered = false;
  while (!options.signal.aborted) {
    // Batches arrive one after another; there is nothing to run in parallel.
    // oxlint-disable-next-line no-await-in-loop
    const batch = await session.next();
    if (batch.kind === "closed") return delivered;
    // Terminal: this subscription delivers nothing more. The reopen resyncs.
    if (batch.kind === "overflow") return false;
    delivered = true;
    options.onUpdate(batch.events);
  }
  return delivered;
}

/** One watch from open to end; see `pump` for what the result means. A throw means it failed. */
async function runSession(options: WatchLoopOptions, reopened: boolean): Promise<boolean> {
  const session = await options.open(options.signal);
  try {
    // Registered first, then reconciled: a change in between is seen by one or the other.
    if (reopened || options.resyncOnFirstOpen) options.onUpdate("resync");
    return await pump(session, options);
  } finally {
    session.close();
  }
}

/** Runs until `signal` aborts, reopening the watch whenever it ends, overflows or fails. */
export async function runWatchLoop(options: WatchLoopOptions): Promise<void> {
  const { signal } = options;
  const backoff = options.backoffMs ?? BACKOFF_MS;
  let attempt = 0;
  let reopened = false;
  while (!signal.aborted) {
    try {
      // oxlint-disable-next-line no-await-in-loop
      if (await runSession(options, reopened)) attempt = 0;
    } catch (error) {
      if (!signal.aborted) console.warn("The file watcher failed, reopening it", error);
    }
    if (signal.aborted) return;
    reopened = true;
    const delay = backoff[Math.min(attempt, backoff.length - 1)] ?? 0;
    attempt += 1;
    // oxlint-disable-next-line no-await-in-loop
    await (options.sleep ?? pause)(delay, signal);
  }
}

async function openSession(runtime: Runtime, signal: AbortSignal): Promise<WatchSession> {
  const client = new FilesystemClient(runtime.filesystem.fork());
  try {
    const root = await client.asyncCall("preopen", ["/"]);
    const watch = await client.watch(root, { recursive: true, signal });
    return {
      next: () => watch.next(),
      close() {
        void watch.close().catch(() => {});
        client.dispose();
      },
    };
  } catch (error) {
    client.dispose();
    throw error;
  }
}

/**
 * Calls `onUpdate` with every change, event names relative to the filesystem root, and with
 * `"resync"` whenever events may have been lost. Returns the function that stops watching.
 */
export function watchFilesystemEvents(
  runtime: Runtime,
  onUpdate: (update: WatchUpdate) => void,
  options: { readonly resyncOnFirstOpen?: boolean } = {},
): () => void {
  const lifetime = new AbortController();
  void runWatchLoop({
    ...options,
    onUpdate,
    open: (signal) => openSession(runtime, signal),
    signal: lifetime.signal,
  });
  return () => lifetime.abort();
}

/**
 * Calls `onChange` with the paths of every change, relative to the filesystem root; `[null]`
 * means "something, anywhere". Returns the function that stops watching.
 */
export function watchFilesystem(
  runtime: Runtime,
  onChange: (names: readonly (string | null)[]) => void,
): () => void {
  return watchFilesystemEvents(runtime, (update) =>
    onChange(update === "resync" ? [null] : update.map((event) => event.name)),
  );
}
