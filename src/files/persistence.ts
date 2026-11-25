// Tracks whether what the workspace holds in memory has reached browser storage. Waffle
// acknowledges a write from memory; only a flush that started after the write makes it survive
// a reload. "saved" is reported for exactly that and nothing weaker.

export type SaveState = "saved" | "saving" | "failed";

export interface Persistence {
  readonly state: SaveState;
  /** A write is starting. Call the returned function when it ended, whether it worked or not. */
  begin(): () => void;
  /** Something changed in memory and needs a flush. */
  touch(): void;
  /**
   * Resolves once every change acknowledged before this call is flushed, however many changes
   * follow: a caller waits for its own write, not for the workspace to go quiet. Rejects when
   * a flush fails.
   */
  settled(): Promise<void>;
  /** Storage is gone (another tab took the workspace): no more flushes, the state is `failed`. */
  stop(reason: Error): void;
}

interface Waiter {
  /** The change count a flush has to cover before this waiter is done. */
  readonly target: number;
  resolve(): void;
  reject(reason: unknown): void;
}

export function createPersistence(
  flush: () => Promise<void>,
  report: (state: SaveState) => void,
): Persistence {
  let changes = 0;
  let flushed = 0;
  let writing = 0;
  let running = false;
  let stopped = false;
  let failure: unknown;
  let waiters: Waiter[] = [];

  function current(): SaveState {
    if (failure !== undefined) return "failed";
    return writing > 0 || flushed < changes ? "saving" : "saved";
  }

  function publish(): void {
    report(current());
    const waiting = waiters;
    waiters = [];
    for (const waiter of waiting) {
      if (failure !== undefined) waiter.reject(failure);
      else if (waiter.target <= flushed) waiter.resolve();
      else waiters.push(waiter);
    }
  }

  async function pump(): Promise<void> {
    if (running || failure !== undefined || flushed === changes) return;
    running = true;
    const target = changes;
    try {
      await flush();
      flushed = target;
    } catch (error) {
      failure ??= error ?? new Error("Flushing to browser storage failed");
    }
    running = false;
    publish();
    void pump();
  }

  return {
    get state() {
      return current();
    },
    begin() {
      writing += 1;
      publish();
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        writing -= 1;
        publish();
      };
    },
    touch() {
      changes += 1;
      // A change after a failed flush is a reason to try again, unless storage is gone for good.
      if (!stopped) failure = undefined;
      publish();
      void pump();
    },
    settled() {
      if (failure !== undefined) return Promise.reject(failure);
      const target = changes;
      if (target <= flushed) return Promise.resolve();
      return new Promise<void>((resolve, reject) => waiters.push({ target, resolve, reject }));
    },
    stop(reason) {
      stopped = true;
      failure = reason;
      publish();
    },
  };
}
