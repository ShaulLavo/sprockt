// Tabs attached to one workspace run FileService operations at the same time. Some of them check
// something and then act on it (write only if the file still holds the expected text; rename only
// if the destination is free), and Waffle has no single step for either. Web Locks make each
// check-and-act one step for every tab of this origin. Programs in a terminal do not take these
// locks; only FileService (the editor, the explorer, uploads, imports) is covered.
//
// Locks are hierarchical: an operation holds its own paths exclusively and every directory above
// them shared. A folder move or delete holds the folder exclusively, so it waits for writes
// inside it and keeps new ones out until it is done. Every operation takes its locks one at a time
// in one global order (sorted by path, so a directory comes before everything inside it), which
// keeps any two operations from waiting on each other in a cycle.

/** The paths an operation needs: written or replaced (exclusive), or only walked through (shared). */
export interface LockRequest {
  readonly exclusive: readonly string[];
  readonly shared?: readonly string[];
}

/** Runs work while holding the locks of a request, in all tabs of this origin. */
export interface PathLocks {
  hold<T>(request: LockRequest, work: () => Promise<T>): Promise<T>;
}

type LockManagerLike = Pick<LockManager, "request">;

/** Every directory above `path` (absolute, normalized), the top one first; not `path` itself. */
export function ancestorsOf(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  return parts.slice(0, -1).map((_, index) => `/${parts.slice(0, index + 1).join("/")}`);
}

/**
 * The locks of a request in the order they are taken: each path once, exclusive when any part of
 * the request needs it exclusively, sorted so a directory comes before what is inside it.
 */
export function lockPlan(request: LockRequest): { readonly path: string; readonly mode: LockMode }[] {
  const exclusive = new Set(request.exclusive);
  const all = new Set(request.exclusive.concat(request.shared ?? []));
  return Array.from(all)
    .sort()
    .map((path) => ({ path, mode: exclusive.has(path) ? "exclusive" : "shared" }));
}

/**
 * Locks named `sprockt:<workspace>:path:<absolute path>`, taken one at a time in `lockPlan` order
 * and released together when the work settles.
 */
export function webPathLocks(workspaceId: string, locks: LockManagerLike): PathLocks {
  const lockName = (path: string) => `sprockt:${workspaceId}:path:${path}`;
  function holdAll<T>(plan: ReturnType<typeof lockPlan>, work: () => Promise<T>): Promise<T> {
    const [first, ...rest] = plan;
    if (first === undefined) return work();
    return locks.request(lockName(first.path), { mode: first.mode }, () => holdAll(rest, work));
  }
  return { hold: (request, work) => holdAll(lockPlan(request), work) };
}

interface Waiter {
  readonly mode: LockMode;
  readonly grant: () => void;
}

/** One page's shared and exclusive locks, first come first served. For tests and lock-less browsers. */
export function localPathLocks(): PathLocks {
  const held = new Map<string, LockMode[]>();
  const queues = new Map<string, Waiter[]>();

  const fits = (path: string, mode: LockMode) => {
    const holders = held.get(path) ?? [];
    return holders.length === 0 || (mode === "shared" && holders.every((other) => other === "shared"));
  };

  function pump(path: string): void {
    const queue = queues.get(path) ?? [];
    while (queue.length > 0 && fits(path, queue[0]!.mode)) {
      const next = queue.shift()!;
      held.set(path, (held.get(path) ?? []).concat([next.mode]));
      next.grant();
    }
  }

  function take(path: string, mode: LockMode): Promise<() => void> {
    const granted = Promise.withResolvers<void>();
    queues.set(path, (queues.get(path) ?? []).concat([{ mode, grant: granted.resolve }]));
    pump(path);
    return granted.promise.then(() => () => {
      const holders = held.get(path) ?? [];
      holders.splice(holders.indexOf(mode), 1);
      pump(path);
    });
  }

  return {
    async hold(request, work) {
      const releases: (() => void)[] = [];
      try {
        for (const { path, mode } of lockPlan(request)) {
          // One at a time, in plan order, as the Web Locks version does.
          // oxlint-disable-next-line no-await-in-loop
          releases.push(await take(path, mode));
        }
        return await work();
      } finally {
        for (const release of releases.toReversed()) release();
      }
    },
  };
}

/** Web Locks where the browser has them (every target browser does), otherwise one page's. */
export function pathLocksFor(workspaceId: string): PathLocks {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  return locks ? webPathLocks(workspaceId, locks) : localPathLocks();
}
