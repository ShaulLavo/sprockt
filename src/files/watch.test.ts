import { expect, test } from "bun:test";
import type { WatchBatch } from "waffle/fs";
import { runWatchLoop, type WatchSession } from "./watch";

type Step = WatchBatch | Error;

const events = (...names: (string | null)[]): WatchBatch => ({
  kind: "events",
  events: names.map((name, index) => ({ type: "change", id: BigInt(index), name })),
});
const closed: WatchBatch = { kind: "closed", events: [] };
const overflow: WatchBatch = { kind: "overflow", events: [] };

/** A session that plays `steps`, then stops the loop. Reading past an overflow is recorded. */
function session(steps: Step[], log: string[], stop: () => void): WatchSession {
  let overflowed = false;
  return {
    async next() {
      if (overflowed) log.push("read after overflow");
      const step = steps.shift();
      if (step === undefined) {
        stop();
        return closed;
      }
      if (step instanceof Error) throw step;
      overflowed = step.kind === "overflow";
      return step;
    },
    close: () => void log.push("close"),
  };
}

/** Runs the loop over `sessions`, in order; an Error entry is an open that fails. */
async function run(
  sessions: (Step[] | Error)[],
  options: { delays?: number[]; backoffMs?: readonly number[]; resyncOnFirstOpen?: boolean } = {},
): Promise<string[]> {
  const lifetime = new AbortController();
  const log: string[] = [];
  const queue = Array.from(sessions);
  await runWatchLoop({
    signal: lifetime.signal,
    backoffMs: options.backoffMs ?? [0],
    resyncOnFirstOpen: options.resyncOnFirstOpen,
    async sleep(ms) {
      options.delays?.push(ms);
    },
    onUpdate: (update) =>
      log.push(
        update === "resync" ? "resync" : `names ${update.map((event) => event.name ?? "null").join(",")}`,
      ),
    async open() {
      log.push("open");
      const next = queue.shift();
      if (next === undefined) {
        lifetime.abort();
        throw new Error("no more sessions");
      }
      if (next instanceof Error) throw next;
      return session(next, log, () => queue.length === 0 && lifetime.abort());
    },
  });
  return log;
}

test("event names are passed on as they come", async () => {
  const log = await run([[events("workspace/src/a.ts", "bin/bun")]]);
  expect(log).toContain("names workspace/src/a.ts,bin/bun");
});

test("an overflowed watch is never read again: it is closed, a new one opens, then the listener resyncs", async () => {
  const log = await run([[overflow, events("lost.ts")], [events("workspace/b.ts")]]);
  expect(log.slice(0, 4)).toEqual(["open", "close", "open", "resync"]);
  expect(log).not.toContain("read after overflow");
  expect(log).not.toContain("names lost.ts");
  expect(log).toContain("names workspace/b.ts");
});

test("the first open resyncs only when asked to", async () => {
  expect(await run([[events("workspace/a.ts")]])).not.toContain("resync");
  const log = await run([[events("workspace/a.ts")]], { resyncOnFirstOpen: true });
  expect(log.slice(0, 2)).toEqual(["open", "resync"]);
});

test("a failing watch is reopened, and so is one that closes by itself", async () => {
  const log = await run([[new Error("revoked")], [closed], [events("workspace/c.ts")]]);
  expect(log.filter((entry) => entry === "open")).toHaveLength(3);
  expect(log.filter((entry) => entry === "resync")).toHaveLength(2);
  expect(log).toContain("names workspace/c.ts");
});

test("a failed open is retried until it works, and only the success resyncs", async () => {
  const log = await run([new Error("not ready"), new Error("still not"), [events("workspace/d.ts")]]);
  expect(log.filter((entry) => entry === "open")).toHaveLength(3);
  expect(log.filter((entry) => entry === "resync")).toHaveLength(1);
});

test("stopping ends the loop and closes the session", async () => {
  const log = await run([[events("workspace/e.ts")]]);
  expect(log.at(-1)).toBe("close");
});

test("a watch that keeps overflowing backs off further each time, and a healthy one starts it over", async () => {
  const delays: number[] = [];
  await run([[overflow], [overflow], [overflow], [events("workspace/a.ts"), closed], [overflow]], {
    delays,
    backoffMs: [10, 20, 40],
  });
  expect(delays.slice(0, 5)).toEqual([10, 20, 40, 10, 20]);
});
