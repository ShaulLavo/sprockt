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
  /** Resolves once everything changed so far is flushed. Rejects when a flush fails. */
  settled(): Promise<void>;
  /** Storage is gone (another tab took the workspace): no more flushes, the state is `failed`. */
  stop(reason: Error): void;
}

interface Waiter {
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
    const state = current();
    report(state);
    if (state === "saving") return;
    const settling = waiters;
    waiters = [];
    for (const waiter of settling) {
      if (state === "saved") waiter.resolve();
      else waiter.reject(failure);
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
      const state = current();
      if (state === "saved") return Promise.resolve();
      if (state === "failed") return Promise.reject(failure);
      return new Promise<void>((resolve, reject) => waiters.push({ resolve, reject }));
    },
    stop(reason) {
      stopped = true;
      failure = reason;
      publish();
    },
  };
}
