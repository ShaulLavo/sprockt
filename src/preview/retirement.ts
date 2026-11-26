// Whether the preview service worker may answer, decided from what lasts, never from memory.
//
// A browser stops an idle worker and starts it again with nothing remembered, and a worker that
// was unregistered stays in charge of the pages it already controls. So the worker asks two
// things that outlive it:
//
// - a flag in the origin's cache storage, set when a build without previews retired it (by that
//   build's page, retire.ts, or by the worker itself). Read every time the worker starts.
// - the deploy: a build with previews publishes a small file saying so (`/preview-mode.json`),
//   and a build without them does not. Asked for every request the worker would answer, and
//   every socket: no earlier answer is trusted, however recent. A deploy that says no retires
//   the worker, and a deploy that cannot be asked (offline, a server error) is not served
//   for: the worker answers from the workspace only when the deploy has just said it may.
import { freshly } from "./fresh";

export const RETIRED_CACHE = "sprockt-preview-worker";
export const RETIRED_KEY = "/__preview/__retired";

/** What `/preview-mode.json` holds in a build with mounted previews. */
export const MOUNTED_MODE = { previews: "mounted" } as const;

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
}

export interface Retirement {
  /**
   * Whether a request may be answered from the workspace: only when the deploy, asked after
   * the request arrived, says previews are on. `navigation` also reads the retired flag anew:
   * a page load is where a build with previews gets its worker back.
   */
  allowed(navigation: boolean): Promise<boolean>;
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

/**
 * Whether the deploy says yes, asked anew for every caller (fresh.ts). No answer is a no. For
 * the tab that runs a server, which keeps live sockets under the deploy's word (tunnels.ts).
 */
export function freshDeployYes(fetchMode: () => Promise<Response>): () => Promise<boolean> {
  return freshly(async () => (await deployAllows(fetchMode)) === true);
}

export function createRetirement(options: RetirementOptions): Retirement {
  // Read once, when the worker starts: this is what a restart cannot forget.
  let retired: Promise<boolean> = options.flag.has().catch(() => false);

  async function retire(): Promise<void> {
    retired = Promise.resolve(true);
    await options.flag.set().catch(() => {});
    await options.unregister().catch(() => {});
  }

  async function check(): Promise<boolean> {
    const verdict = await deployAllows(options.fetchMode);
    if (verdict === false) await retire();
    // No answer is not a yes: a deploy that cannot be asked is not served for. It is not a no
    // either, so the worker stays, and serves again once the deploy says it may.
    return verdict === true;
  }

  /**
   * The deploy's word for one request: from a question asked after the request arrived, never
   * from an earlier one (fresh.ts).
   */
  const verified = freshly(check);

  return {
    retire,
    async allowed(navigation) {
      // Retired stays retired, with one way back: a build with previews clears the flag before
      // it registers the worker again (mounted.ts), and a navigation reads the flag anew.
      if (navigation && (await retired)) retired = options.flag.has().catch(() => true);
      if (await retired) return false;
      const allowed = await verified();
      // It may have been retired by a message while the deploy was being asked.
      return allowed && !(await retired);
    },
  };
}
