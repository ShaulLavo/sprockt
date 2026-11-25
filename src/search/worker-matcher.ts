// A FileMatcher backed by a dedicated worker. One per search run: `dispose` (or the run's abort
// signal) terminates the worker, rejects whatever is still pending and frees the thread even if a
// match is stuck backtracking. A worker that fails, at startup or later, fails every pending and
// later match, so the search ends with an error instead of waiting for ever.
import type { MatchReply, MatchRequest } from "./match-worker";
import type { FileMatcher } from "./project";

export interface WorkerMatcher {
  readonly match: FileMatcher;
  dispose(): void;
}

/** The part of a Worker the matcher uses, so tests can stand in a failing one. */
export interface MatchWorker extends EventTarget {
  postMessage(message: MatchRequest, transfer: Transferable[]): void;
  terminate(): void;
}

interface Pending {
  resolve(matches: MatchReply["matches"]): void;
  reject(reason: unknown): void;
}

const startWorker = (): MatchWorker =>
  new Worker(new URL("./match-worker.ts", import.meta.url), { type: "module" });

const cancelled = () => new DOMException("The search was cancelled", "AbortError");

export function createWorkerMatcher(
  signal: AbortSignal,
  start: () => MatchWorker = startWorker,
): WorkerMatcher {
  const worker = start();
  const pending = new Map<number, Pending>();
  let nextId = 0;
  /** Set once the worker is gone: cancelled, disposed or failed. Every match rejects with it. */
  let ended: unknown;

  function end(reason: unknown): void {
    if (ended !== undefined) return;
    ended = reason;
    worker.terminate();
    for (const waiter of pending.values()) waiter.reject(reason);
    pending.clear();
  }

  const fail = (event: Event) => {
    const message =
      event instanceof ErrorEvent && event.message ? event.message : "The search worker stopped";
    end(new Error(message));
  };

  worker.addEventListener("message", (event) => {
    const reply = (event as MessageEvent<MatchReply>).data;
    pending.get(reply.id)?.resolve(reply.matches);
    pending.delete(reply.id);
  });
  worker.addEventListener("error", fail);
  worker.addEventListener("messageerror", fail);
  signal.addEventListener("abort", () => end(cancelled()), { once: true });
  if (signal.aborted) end(cancelled());

  const match: FileMatcher = (bytes, query, limit) =>
    new Promise((resolve, reject) => {
      if (ended !== undefined) return reject(ended);
      const id = nextId;
      nextId += 1;
      pending.set(id, { resolve: (matches) => resolve(matches.slice()), reject });
      // A copy owns a plain ArrayBuffer (file bytes may sit on shared memory) and can be moved.
      const copy = bytes.slice();
      worker.postMessage({ id, bytes: copy, query, limit }, [copy.buffer]);
    });

  return { match, dispose: () => end(cancelled()) };
}
