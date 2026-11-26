import { expect, test } from "bun:test";
import { isSourceChange, restartingProcess, type Run } from "./restarting";

interface FakeRun extends Run {
  readonly script: string;
  interrupts: number;
  /** The run ends by itself. */
  end(): void;
}

function harness(rerun: string | undefined) {
  const runs: FakeRun[] = [];
  const listeners = new Set<() => void>();
  let restarts = 0;
  /** Creating the next run takes until this resolves. */
  const gate = { ready: Promise.resolve() };
  const started = restartingProcess({
    script: "bun install && bun server.ts",
    rerun,
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
    onSourceChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onRestart: () => void restarts++,
  });
  return {
    runs,
    gate,
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

const change = (paths: string[], reset = false) => ({ paths, reset });

test("code, pages and styles are source; what a server writes and what is installed are not", () => {
  expect(isSourceChange(change(["server.ts"]))).toBe(true);
  expect(isSourceChange(change(["src/routes/index.tsx", "notes.sqlite"]))).toBe(true);
  expect(isSourceChange(change(["lib/util.mjs"]))).toBe(true);
  expect(isSourceChange(change(["src/page.html"]))).toBe(true);
  expect(isSourceChange(change(["notes.sqlite", "notes.sqlite-wal", "data.json", "app.log"]))).toBe(false);
  expect(isSourceChange(change(["node_modules/hono/dist/index.js"]))).toBe(false);
  expect(isSourceChange(change([".git/hooks/pre-commit.js"]))).toBe(false);
  expect(isSourceChange(change([]))).toBe(false);
  // Events were lost: anything may have changed.
  expect(isSourceChange(change([], true))).toBe(true);
});
