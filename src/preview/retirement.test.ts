import { expect, test } from "bun:test";
import { createRetirement, MOUNTED_MODE, RECHECK_MS, type RetirementOptions } from "./retirement";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const mounted = () => json(MOUNTED_MODE);
const missing = () => new Response("Not found\n", { status: 404 });
const appShell = () =>
  new Response("<!doctype html><title>Sprockt</title>", { headers: { "content-type": "text/html" } });

/** What outlives a worker: the flag in cache storage, the deploy, the registration. */
function browser(deploy: () => Response | Promise<Response>) {
  const world = {
    deploy,
    flagged: false,
    unregistered: 0,
    asked: 0,
    time: 0,
    /** A worker as the browser starts it: nothing remembered but what `world` holds. */
    startWorker() {
      const options: RetirementOptions = {
        flag: {
          has: async () => world.flagged,
          set: async () => void (world.flagged = true),
        },
        fetchMode: async () => {
          world.asked++;
          return world.deploy();
        },
        unregister: async () => void world.unregistered++,
        now: () => world.time,
      };
      return createRetirement(options);
    },
  };
  return world;
}

test("a worker serves while the deploy says previews are on", async () => {
  const world = browser(mounted);
  const worker = world.startWorker();
  expect(await worker.allowed(false)).toBe(true);
  expect(world.unregistered).toBe(0);
});

test("a worker that was retired stays retired when the browser starts it again", async () => {
  // The deploy still says yes: only the flag keeps the restarted worker from serving.
  const world = browser(mounted);
  const first = world.startWorker();
  expect(await first.allowed(false)).toBe(true);
  await first.retire();
  expect(await first.allowed(false)).toBe(false);
  expect(world.unregistered).toBe(1);

  const restarted = world.startWorker();
  expect(await restarted.allowed(false)).toBe(false);
  expect(await restarted.allowed(true)).toBe(false);
});

test("a build with previews that clears the flag has its worker back at the next navigation", async () => {
  const world = browser(mounted);
  const worker = world.startWorker();
  await worker.retire();
  expect(await worker.allowed(true)).toBe(false);

  // What mounted.ts does before it registers the worker again.
  world.flagged = false;
  // Not for a request that is no navigation: the flag is read anew only for a page load.
  expect(await worker.allowed(false)).toBe(false);
  expect(await worker.allowed(true)).toBe(true);
  expect(await worker.allowed(false)).toBe(true);
});

test("a deploy without previews retires the worker the first time it is asked", async () => {
  for (const deploy of [missing, appShell, () => json({ previews: "off" }), () => json("mounted")]) {
    const world = browser(deploy);
    const worker = world.startWorker();
    // oxlint-disable-next-line no-await-in-loop
    expect(await worker.allowed(false)).toBe(false);
    expect(world.flagged).toBe(true);
    expect(world.unregistered).toBe(1);
    // And a worker started later never asks its way back in.
    world.deploy = mounted;
    // oxlint-disable-next-line no-await-in-loop
    expect(await world.startWorker().allowed(true)).toBe(false);
  }
});

test("a navigation asks the deploy again; other requests trust a recent answer for a while", async () => {
  const world = browser(mounted);
  const worker = world.startWorker();
  expect(await worker.allowed(false)).toBe(true);
  expect(await worker.allowed(false)).toBe(true);
  expect(world.asked).toBe(1);

  // The deploy changes under a running worker.
  world.deploy = missing;
  expect(await worker.allowed(false)).toBe(true);
  // A page navigation is not answered from the old deploy's word.
  expect(await worker.allowed(true)).toBe(false);
  expect(await worker.allowed(false)).toBe(false);
  expect(world.unregistered).toBe(1);
});

test("a recent answer runs out, and the next request of any kind asks again", async () => {
  const world = browser(mounted);
  const worker = world.startWorker();
  expect(await worker.allowed(false)).toBe(true);
  world.deploy = missing;
  world.time += RECHECK_MS - 1;
  expect(await worker.allowed(false)).toBe(true);
  world.time += 1;
  expect(await worker.allowed(false)).toBe(false);
});

test("requests that arrive together ask the deploy once", async () => {
  const world = browser(mounted);
  const worker = world.startWorker();
  const answers = await Promise.all([worker.allowed(true), worker.allowed(true), worker.allowed(false)]);
  expect(answers).toEqual([true, true, true]);
  expect(world.asked).toBe(1);
});

const offline = () => Promise.reject(new TypeError("Failed to fetch"));

test("a deploy that cannot be asked changes nothing: offline work goes on, a flag still holds", async () => {
  const world = browser(offline);
  expect(await world.startWorker().allowed(true)).toBe(true);
  expect(world.unregistered).toBe(0);

  // A server error is no answer either.
  world.deploy = () => new Response("oops", { status: 503 });
  expect(await world.startWorker().allowed(true)).toBe(true);

  world.flagged = true;
  world.deploy = offline;
  expect(await world.startWorker().allowed(true)).toBe(false);
});

test("a flag that cannot be read or written does not break the worker", async () => {
  const worker = createRetirement({
    flag: {
      has: () => Promise.reject(new Error("no storage")),
      set: () => Promise.reject(new Error("no storage")),
    },
    fetchMode: async () => mounted(),
    unregister: () => Promise.reject(new Error("gone")),
  });
  expect(await worker.allowed(false)).toBe(true);
  await worker.retire();
  expect(await worker.allowed(false)).toBe(false);
});
