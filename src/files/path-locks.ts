// Tabs attached to one workspace run FileService operations at the same time. Some of them check
// something and then act on it (write only if the file still holds the expected text; rename only
// if the destination is free), and Waffle has no single step for either. A Web Lock per path makes
// each check-and-act one step for every tab of this origin. Programs in a terminal do not take
// these locks; only FileService (the editor, the explorer, uploads, imports) is covered.

/** Runs work while holding the locks of every given path, in all tabs of this origin. */
export interface PathLocks {
  hold<T>(paths: readonly string[], work: () => Promise<T>): Promise<T>;
}

type LockManagerLike = Pick<LockManager, "request">;

/** One page: work on a path waits for earlier work on it. For tests and lock-less browsers. */
export function localPathLocks(): PathLocks {
  const tails = new Map<string, Promise<unknown>>();
  return {
    async hold(paths, work) {
      const names = Array.from(new Set(paths)).sort();
      const previous = names.map((name) => tails.get(name) ?? Promise.resolve());
      const run = Promise.all(previous).then(work);
      const done = run.catch(() => {});
      for (const name of names) tails.set(name, done);
      try {
        return await run;
      } finally {
        for (const name of names) if (tails.get(name) === done) tails.delete(name);
      }
    },
  };
}

/**
 * Locks named `sprockt:<workspace>:path:<absolute path>`. Several paths are taken one at a time in
 * sorted order, so two operations that need the same paths never wait on each other in a cycle.
 */
export function webPathLocks(workspaceId: string, locks: LockManagerLike): PathLocks {
  const lockName = (path: string) => `sprockt:${workspaceId}:path:${path}`;
  function holdAll<T>(names: readonly string[], work: () => Promise<T>): Promise<T> {
    const [first, ...rest] = names;
    if (first === undefined) return work();
    return locks.request(lockName(first), { mode: "exclusive" }, () => holdAll(rest, work));
  }
  return {
    hold: (paths, work) => holdAll(Array.from(new Set(paths)).sort(), work),
  };
}

/** Web Locks where the browser has them (every target browser does), otherwise one page's. */
export function pathLocksFor(workspaceId: string): PathLocks {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  return locks ? webPathLocks(workspaceId, locks) : localPathLocks();
}
