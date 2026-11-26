import { expect, test } from "bun:test";
import { createRetirement, freshDeployYes, MOUNTED_MODE, type RetirementOptions } from "./retirement";

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

test("every request asks the deploy: no earlier yes is trusted, however recent", async () => {
  const world = browser(mounted);
  const worker = world.startWorker();
  expect(await worker.allowed(false)).toBe(true);
  expect(await worker.allowed(false)).toBe(true);
  expect(world.asked).toBe(2);

  // The deploy changes under a running worker. The very next request, of any kind, is refused:
  // a script, a fetch or a socket of a page that is still open, not only a page load.
  world.deploy = missing;
  expect(await worker.allowed(false)).toBe(false);
  expect(world.asked).toBe(3);
  expect(world.unregistered).toBe(1);
  expect(await worker.allowed(true)).toBe(false);
});

test("requests that arrive together do not ask the deploy once each", async () => {
  const world = browser(mounted);
  const worker = world.startWorker();
  const answers = await Promise.all(Array.from({ length: 20 }, (_, index) => worker.allowed(index === 0)));
  expect(answers).toEqual(Array.from({ length: 20 }, () => true));
  // One question for the first, and one more that all the others share.
  expect(world.asked).toBe(2);
});

test("a request that arrives while the deploy is being asked is not answered by that question", async () => {
  // The deploy's answers, handed out one at a time by the test.
  const answers: PromiseWithResolvers<Response>[] = [];
  const world = browser(() => {
    const answer = Promise.withResolvers<Response>();
    answers.push(answer);
    return answer.promise;
  });
  const worker = world.startWorker();
  const first = worker.allowed(false);
  await Promise.resolve();
  await Promise.resolve();
  expect(world.asked).toBe(1);

  // Two more requests arrive while the first question is out. That question was asked before
  // they came, so its yes is not theirs: they wait for it, and then share one new question.
  const second = worker.allowed(false);
  const third = worker.allowed(false);
  answers[0]?.resolve(mounted());
  expect(await first).toBe(true);
  await Promise.resolve();
  expect(world.asked).toBe(2);
  // Previews went away between the two questions.
  answers[1]?.resolve(missing());
  expect(await Promise.all([second, third])).toEqual([false, false]);
  expect(world.asked).toBe(2);
  expect(world.unregistered).toBe(1);
});

const offline = () => Promise.reject(new TypeError("Failed to fetch"));

test("a deploy that cannot be asked is not served for, and the worker is not retired by it", async () => {
  const world = browser(offline);
  const worker = world.startWorker();
  expect(await worker.allowed(true)).toBe(false);
  expect(await worker.allowed(false)).toBe(false);
  // A server error is no answer either.
  world.deploy = () => new Response("oops", { status: 503 });
  expect(await worker.allowed(false)).toBe(false);
  expect(world.flagged).toBe(false);
  expect(world.unregistered).toBe(0);

  // Not even after it had said yes a moment before.
  world.deploy = mounted;
  expect(await worker.allowed(false)).toBe(true);
  world.deploy = offline;
  expect(await worker.allowed(false)).toBe(false);

  // No answer was not a no: when the deploy answers again, the worker serves again.
  world.deploy = mounted;
  expect(await worker.allowed(false)).toBe(true);
  expect(world.unregistered).toBe(0);
});

test("a flagged worker stays retired when the deploy cannot be asked", async () => {
  const world = browser(offline);
  world.flagged = true;
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

/** A mode answer that sent its head and then nothing: its body ends only when it is let go of. */
function stalledBody(signal: AbortSignal): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"previews":'));
      signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
    },
  });
  return new Response(body, { headers: { "content-type": "application/json" } });
}

test("a mode answer whose body never ends is no answer once the deadline passed, and is let go of", async () => {
  const signals: AbortSignal[] = [];
  const worker = createRetirement({
    flag: { has: async () => false, set: async () => {} },
    fetchMode: async (signal) => {
      signals.push(signal);
      return stalledBody(signal);
    },
    unregister: async () => {},
    deadlineMs: 20,
  });
  expect(await worker.allowed(false)).toBe(false);
  // The request was aborted, so the connection it held is closed.
  expect(signals[0]?.aborted).toBe(true);
});

test("a question to the deploy that never comes back is a no, for the tab that keeps sockets too", async () => {
  // A fetch that ignores its signal is not waited for either.
  const yes = freshDeployYes(() => new Promise<Response>(() => {}), 20);
  expect(await yes()).toBe(false);
  // And one that answers within the deadline is heard.
  const quick = freshDeployYes(async () => mounted(), 1_000);
  expect(await quick()).toBe(true);
});
