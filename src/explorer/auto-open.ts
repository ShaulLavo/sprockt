// Opens the folders of a workspace the person has not touched yet, so a small project shows whole,
// within a hard budget so a big one stays shut. Pure scheduling: the explorer supplies the listing
// and what to do with a listing that fits.
import { joinPath } from "../files/paths";
import { isHeavyName, type DirEntry } from "../files/tree";

export interface AutoOpenOptions {
  /** The most entries, across every listing taken in, that may be put on screen. */
  readonly limit: number;
  /** The most listings requested at once. */
  readonly concurrency: number;
  list(path: string): Promise<readonly DirEntry[] | undefined>;
  /** Called with each listing that fits the budget; the folder is to be shown open. */
  open(path: string, listing: readonly DirEntry[]): void;
}

export interface AutoOpener {
  /** A listing the caller already has (the root, or any refresh of it). Counts toward the budget. */
  offer(directory: string, listing: readonly DirEntry[]): void;
  /** Gives up: nothing more is listed or opened. */
  stop(): void;
  /** Resolves when nothing is queued or running. */
  settled(): Promise<void>;
}

export function createAutoOpener(options: AutoOpenOptions): AutoOpener {
  /** Entries counted per directory, so a refresh of the same directory is not counted twice. */
  const counted = new Map<string, number>();
  const known = new Set<string>();
  const queue: string[] = [];
  const waiting: (() => void)[] = [];
  let total = 0;
  let running = 0;
  let stopped = false;

  function stop(): void {
    stopped = true;
    queue.length = 0;
    notify();
  }

  function notify(): void {
    if (running > 0 || queue.length > 0) return;
    for (const resolve of waiting.splice(0)) resolve();
  }

  /** Adds a directory's entries to the total (replacing what it counted before). */
  function count(directory: string, listing: readonly DirEntry[]): void {
    total += listing.length - (counted.get(directory) ?? 0);
    counted.set(directory, listing.length);
  }

  /** Folders go to the back of the queue: the tree opens level by level, shallow folders first. */
  function enqueueFolders(directory: string, listing: readonly DirEntry[]): void {
    for (const entry of listing) {
      const path = joinPath(directory, entry.name);
      if (entry.kind !== "directory" || isHeavyName(entry.name) || known.has(path)) continue;
      known.add(path);
      queue.push(path);
    }
    pump();
  }

  async function run(path: string): Promise<void> {
    const listing = await options.list(path).catch(() => undefined);
    if (stopped || !listing) return;
    // A listing is taken in whole or not at all.
    if (total + listing.length > options.limit) return stop();
    count(path, listing);
    options.open(path, listing);
    if (total >= options.limit) return stop();
    enqueueFolders(path, listing);
  }

  function pump(): void {
    for (;;) {
      const path = stopped || running >= options.concurrency ? undefined : queue.shift();
      if (path === undefined) return;
      running += 1;
      void run(path).finally(() => {
        running -= 1;
        pump();
        notify();
      });
    }
  }

  return {
    stop,
    offer(directory, listing) {
      if (stopped) return;
      count(directory, listing);
      if (total >= options.limit) return stop();
      enqueueFolders(directory, listing);
    },
    settled: () =>
      running === 0 && queue.length === 0 ? Promise.resolve() : new Promise((r) => waiting.push(r)),
  };
}
