// Whether the preview service worker may answer, decided from what lasts, never from memory.
//
// A browser stops an idle worker and starts it again with nothing remembered, and a worker that
// was unregistered stays in charge of the pages it already controls. So the worker asks two
// things that outlive it:
//
// - a flag in the origin's cache storage, set when a build without previews retired it (by that
//   build's page, retire.ts, or by the worker itself). Read every time the worker starts.
// - the deploy: a build with previews publishes a small file saying so (`/preview-mode.json`),
//   and a build without them does not. Asked when the worker starts, again for every page
//   navigation, and otherwise at most every `RECHECK_MS`. A deploy that says no retires the worker.
export const RETIRED_CACHE = "sprockt-preview-worker";
export const RETIRED_KEY = "/__preview/__retired";

/** What `/preview-mode.json` holds in a build with mounted previews. */
export const MOUNTED_MODE = { previews: "mounted" } as const;

/** How long an answer from the deploy is good for, for requests that are not navigations. */
export const RECHECK_MS = 30_000;

/** The durable flag. Every method tolerates a browser without cache storage. */
export interface RetiredFlag {
  has(): Promise<boolean>;
  set(): Promise<void>;
  clear(): Promise<void>;
}

export function retiredFlag(storage: CacheStorage | undefined): RetiredFlag {
  return {
    async has() {
      const cache = await storage?.open(RETIRED_CACHE);
      return (await cache?.match(RETIRED_KEY)) !== undefined;
    },
    async set() {
      const cache = await storage?.open(RETIRED_CACHE);
      await cache?.put(RETIRED_KEY, new Response("retired"));
    },
    async clear() {
      await storage?.delete(RETIRED_CACHE);
    },
  };
}

export interface RetirementOptions {
  readonly flag: Pick<RetiredFlag, "has" | "set">;
  /** Fetches the deploy's mode file, past every cache. Rejects when the network cannot be reached. */
  fetchMode(): Promise<Response>;
  unregister(): Promise<unknown>;
  now?(): number;
}

export interface Retirement {
  /**
   * Whether a request may be answered from the workspace. `fresh` asks the deploy now instead
   * of trusting a recent answer: a navigation is what would show a page that should be gone.
   */
  allowed(fresh: boolean): Promise<boolean>;
  /** Stops answering for good: sets the flag and removes the registration. */
  retire(): Promise<void>;
}

/** What the deploy says: previews on, previews off, or no answer (offline, a server error). */
async function deployAllows(fetchMode: () => Promise<Response>): Promise<boolean | undefined> {
  const response = await fetchMode().catch(() => undefined);
  if (!response || response.status >= 500) return undefined;
  if (!response.ok) return false;
  // A host that answers every unknown path with its HTML page is saying no as well.
  const body: unknown = await response.json().catch(() => undefined);
  return (
    typeof body === "object" && body !== null && "previews" in body && body.previews === MOUNTED_MODE.previews
  );
}

export function createRetirement(options: RetirementOptions): Retirement {
  const now = options.now ?? Date.now;
  // Read once, when the worker starts: this is what a restart cannot forget.
  let retired: Promise<boolean> = options.flag.has().catch(() => false);
  let checked: { readonly at: number; readonly allowed: boolean } | undefined;
  let checking: Promise<boolean> | undefined;

  async function retire(): Promise<void> {
    retired = Promise.resolve(true);
    await options.flag.set().catch(() => {});
    await options.unregister().catch(() => {});
  }

  async function check(): Promise<boolean> {
    const verdict = await deployAllows(options.fetchMode);
    if (verdict === false) {
      await retire();
      return false;
    }
    // No answer: what held before still holds. Development works offline, and a flagged worker
    // is retired by the flag, not by this.
    const allowed = verdict ?? checked?.allowed ?? true;
    checked = { at: now(), allowed };
    return allowed;
  }

  return {
    retire,
    async allowed(fresh) {
      // Retired stays retired, with one way back: a build with previews clears the flag before
      // it registers the worker again (mounted.ts), and a navigation reads the flag anew.
      if (fresh && (await retired)) retired = options.flag.has().catch(() => true);
      if (await retired) return false;
      const recent = checked !== undefined && now() - checked.at < RECHECK_MS;
      if (recent && !fresh) return checked?.allowed ?? false;
      checking ??= check().finally(() => {
        checking = undefined;
      });
      const allowed = await checking;
      // It may have been retired by a message while the deploy was being asked.
      return allowed && !(await retired);
    },
  };
}
