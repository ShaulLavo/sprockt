import { expect, test } from "bun:test";
import { affectsProject, isSourceEdit, restartingProcess, RESTART_LIMIT, type Run } from "./restarting";

interface FakeRun extends Run {
  readonly script: string;
  interrupts: number;
  /** The run ends by itself. */
  end(): void;
}

function harness(rerun: string | undefined, signal?: AbortSignal) {
  const runs: FakeRun[] = [];
  const listeners = new Set<() => void>();
  /** Every call of `onHeld`, in order. */
  const held: boolean[] = [];
  let restarts = 0;
  /** Creating the next run takes until this resolves. */
  const gate = { ready: Promise.resolve() };
  /** The time the restart limit is counted on, moved by hand. */
  const clock = { now: 0 };
  const started = restartingProcess({
    script: "bun install && bun server.ts",
    rerun,
    ...(signal ? { signal } : {}),
    now: () => clock.now,
    onHeld: (value) => void held.push(value),
    async open(script) {
      await gate.ready;
      const ended = Promise.withResolvers<void>();
      const run: FakeRun = {
        script,
        done: ended.promise,
        interrupts: 0,
        interrupt() {
          run.interrupts++;
          ended.resolve();
        },
        end: () => ended.resolve(),
      };
      runs.push(run);
      return run;
    },
    onSourceEdit(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onRestart: () => void restarts++,
  });
  return {
    runs,
    gate,
    clock,
    held,
    started,
    listeners,
    restarts: () => restarts,
    change() {
      for (const listener of listeners) listener();
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test("a source change stops the run and starts the command again, without the install", async () => {
  const { runs, started, change, restarts } = harness("bun server.ts");
  const process = await started;
  let exited = false;
  void process.exited.then(() => (exited = true));

  change();
  await settle();
  expect(runs.map((run) => run.script)).toEqual(["bun install && bun server.ts", "bun server.ts"]);
  expect(runs[0]?.interrupts).toBe(1);
  expect(restarts()).toBe(1);
  // A restart is not the end of the process.
  expect(exited).toBe(false);

  change();
  await settle();
  expect(runs).toHaveLength(3);
  expect(exited).toBe(false);
});

test("stop ends it for good, and later changes start nothing", async () => {
  const { runs, started, change, listeners } = harness("bun server.ts");
  const process = await started;
  process.stop();
  await process.exited;
  expect(runs[0]?.interrupts).toBe(1);
  expect(listeners.size).toBe(0);
  change();
  await settle();
  expect(runs).toHaveLength(1);
});

test("a run that ends by itself ends the process: a crashed server is not started in a loop", async () => {
  const { runs, started, change } = harness("bun server.ts");
  const process = await started;
  runs[0]?.end();
  await process.exited;
  change();
  await settle();
  expect(runs).toHaveLength(1);
});

test("several changes in a row make one restart, and a change during a restart makes one more", async () => {
  const { runs, gate, started, change } = harness("bun server.ts");
  await started;
  const ready = Promise.withResolvers<void>();
  gate.ready = ready.promise;
  change();
  change();
  change();
  await settle();
  // The next run is still being created when another change comes.
  change();
  ready.resolve();
  gate.ready = Promise.resolve();
  await settle();
  // Run 2 was created for the first three changes, stopped at once for the fourth, and run 3 follows.
  expect(runs).toHaveLength(3);
  expect(runs[1]?.interrupts).toBe(1);
  expect(runs[2]?.interrupts).toBe(0);
});

test("a stop while the next run is being created stops that run too", async () => {
  const { runs, gate, started, change } = harness("bun server.ts");
  const process = await started;
  const ready = Promise.withResolvers<void>();
  gate.ready = ready.promise;
  change();
  await settle();
  process.stop();
  ready.resolve();
  await process.exited;
  expect(runs).toHaveLength(2);
  expect(runs[1]?.interrupts).toBe(1);
});

test("a command that reloads itself is left alone", async () => {
  const { runs, started, change, listeners } = harness(undefined);
  const process = await started;
  expect(listeners.size).toBe(0);
  change();
  await settle();
  expect(runs).toHaveLength(1);
  expect(runs[0]?.interrupts).toBe(0);
  process.stop();
  await process.exited;
});

const seen = (paths: string[], reset = false) => ({ paths, reset });

test("an edit to code, a page or a style is one to restart for; data and installed files are not", () => {
  expect(isSourceEdit(["server.ts"])).toBe(true);
  expect(isSourceEdit(["src/routes/index.tsx", "notes.sqlite"])).toBe(true);
  expect(isSourceEdit(["lib/util.mjs"])).toBe(true);
  expect(isSourceEdit(["src/page.html"])).toBe(true);
  expect(isSourceEdit(["notes.sqlite", "notes.sqlite-wal", "data.json", "app.log"])).toBe(false);
  expect(isSourceEdit(["node_modules/hono/dist/index.js"])).toBe(false);
  expect(isSourceEdit([".git/hooks/pre-commit.js"])).toBe(false);
  expect(isSourceEdit([])).toBe(false);
});

test("after three restarts in thirty seconds the next edit is not picked up, and that is said", async () => {
  const { runs, clock, held, started, change } = harness("bun server.ts");
  await started;
  for (let edit = 0; edit < RESTART_LIMIT.restarts; edit++) {
    clock.now += 1000;
    change();
    // oxlint-disable-next-line no-await-in-loop
    await settle();
  }
  expect(runs).toHaveLength(1 + RESTART_LIMIT.restarts);
  expect(held).not.toContain(true);

  // The fourth edit within the window: the server keeps running what it has.
  clock.now += 1000;
  change();
  await settle();
  expect(runs).toHaveLength(1 + RESTART_LIMIT.restarts);
  expect(runs.at(-1)?.interrupts).toBe(0);
  expect(held.at(-1)).toBe(true);

  // Once the window has passed, an edit restarts it again, with everything edited since.
  clock.now += RESTART_LIMIT.windowMs;
  change();
  await settle();
  expect(runs).toHaveLength(2 + RESTART_LIMIT.restarts);
  expect(held.at(-1)).toBe(false);
});

test("a server that is no longer wanted when its run is ready is ended at once", async () => {
  const cancel = new AbortController();
  const { runs, gate, started, change } = harness("bun server.ts", cancel.signal);
  const ready = Promise.withResolvers<void>();
  gate.ready = ready.promise;
  cancel.abort();
  ready.resolve();
  const process = await started;
  await process.exited;
  expect(runs).toHaveLength(1);
  expect(runs[0]?.interrupts).toBe(1);
  change();
  await settle();
  expect(runs).toHaveLength(1);
});

test("any file of the project itself may change what there is to start; installed files do not", () => {
  expect(affectsProject(seen(["package.json"]))).toBe(true);
  expect(affectsProject(seen(["notes.sqlite"]))).toBe(true);
  expect(affectsProject(seen(["node_modules/vite/package.json", ".git/index"]))).toBe(false);
  expect(affectsProject(seen([]))).toBe(false);
  expect(affectsProject(seen([], true))).toBe(true);
});
