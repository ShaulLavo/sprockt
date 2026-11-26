import { expect, test } from "bun:test";
import { isPreviewsOff } from "./host-protocol";
import { retirePreviewWorker } from "./retire";
import { RETIRED_CACHE, RETIRED_KEY, retiredFlag } from "./retirement";

const ORIGIN = "https://ide.test";

/** What happened, in order: the flag has to be set before the worker is touched. */
function recorder() {
  const steps: string[] = [];
  const flag = { set: async () => void steps.push("flag") };
  return { steps, flag };
}

function registration(
  scope: string,
  states: readonly ("active" | "waiting" | "installing")[],
  steps: string[] = [],
) {
  const told: unknown[] = [];
  const worker = {
    postMessage(message: unknown) {
      told.push(message);
      steps.push("told");
    },
  } as unknown as ServiceWorker;
  const entry = {
    scope,
    active: states.includes("active") ? worker : null,
    waiting: states.includes("waiting") ? worker : null,
    installing: states.includes("installing") ? worker : null,
    unregistered: 0,
    told,
    async unregister() {
      entry.unregistered++;
      steps.push("unregistered");
      return true;
    },
  };
  return entry;
}

test("the preview worker of an earlier build is flagged, told to stop and unregistered", async () => {
  const { steps, flag } = recorder();
  const preview = registration(`${ORIGIN}/__preview/`, ["active", "waiting"], steps);
  const container = { getRegistrations: async () => [preview] };
  expect(await retirePreviewWorker(container, ORIGIN, flag)).toBe(1);
  expect(preview.unregistered).toBe(1);
  // Both the worker in charge and the one waiting to replace it hear it.
  expect(preview.told).toHaveLength(2);
  expect(preview.told.every(isPreviewsOff)).toBe(true);
  // The flag first: it is what the worker reads if the browser restarts it at any point after.
  expect(steps).toEqual(["flag", "told", "told", "unregistered"]);
});

test("a worker of any other scope is left alone, and nothing is flagged", async () => {
  const { steps, flag } = recorder();
  const other = registration(`${ORIGIN}/`, ["active"], steps);
  const nested = registration(`${ORIGIN}/__preview/abc/`, ["active"], steps);
  const container = { getRegistrations: async () => [other, nested] };
  expect(await retirePreviewWorker(container, ORIGIN, flag)).toBe(0);
  expect(steps).toEqual([]);
});

test("a browser without service workers has nothing to retire", async () => {
  expect(await retirePreviewWorker(undefined, ORIGIN, recorder().flag)).toBe(0);
});

test("a flag that cannot be written does not keep the worker from being removed", async () => {
  const preview = registration(`${ORIGIN}/__preview/`, ["active"]);
  const container = { getRegistrations: async () => [preview] };
  const broken = { set: () => Promise.reject(new Error("no storage")) };
  expect(await retirePreviewWorker(container, ORIGIN, broken)).toBe(1);
  expect(preview.unregistered).toBe(1);
});

/** Cache storage as far as the flag uses it. */
function fakeCaches() {
  const stores = new Map<string, Map<string, Response>>();
  const storage = {
    async open(name: string) {
      const store = stores.get(name) ?? new Map<string, Response>();
      stores.set(name, store);
      return {
        match: async (key: string) => store.get(key),
        put: async (key: string, response: Response) => void store.set(key, response),
      };
    },
    delete: async (name: string) => stores.delete(name),
  };
  return { stores, storage: storage as unknown as CacheStorage };
}

test("the flag lives in cache storage: set by one, read by another, cleared for a build with previews", async () => {
  const { stores, storage } = fakeCaches();
  expect(await retiredFlag(storage).has()).toBe(false);
  await retiredFlag(storage).set();
  expect(stores.get(RETIRED_CACHE)?.has(RETIRED_KEY)).toBe(true);
  // Another holder of the same storage, as a restarted worker is.
  expect(await retiredFlag(storage).has()).toBe(true);
  await retiredFlag(storage).clear();
  expect(await retiredFlag(storage).has()).toBe(false);
  // A browser without cache storage has no flag, and nothing throws.
  expect(await retiredFlag(undefined).has()).toBe(false);
  await retiredFlag(undefined).set();
  await retiredFlag(undefined).clear();
});
