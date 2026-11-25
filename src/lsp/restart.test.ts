import { expect, test } from "bun:test";
import { createRestartScheduler, type Clock } from "./restart";

/** A clock that only moves when the test says so. */
function fakeClock() {
  let time = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const clock: Clock = {
    now: () => time,
    setTimeout(run, ms) {
      nextId += 1;
      timers.set(nextId, { at: time + ms, run });
      return nextId;
    },
    clearTimeout: (handle) => void timers.delete(handle as number),
  };
  const advance = (ms: number) => {
    time += ms;
    for (const [id, timer] of Array.from(timers)) {
      if (timer.at > time) continue;
      timers.delete(id);
      timer.run();
    }
  };
  return { clock, advance };
}

const timing = { quietMs: 1000, minGapMs: 60_000 };

test("a burst of resyncs becomes one restart once it is quiet", () => {
  const { clock, advance } = fakeClock();
  let restarts = 0;
  const scheduler = createRestartScheduler(() => (restarts += 1), timing, clock);
  scheduler.request();
  advance(500);
  scheduler.request();
  advance(900);
  expect(restarts).toBe(0);
  advance(100);
  expect(restarts).toBe(1);
});

test("a second restart waits until the gap since the first has passed", () => {
  const { clock, advance } = fakeClock();
  let restarts = 0;
  const scheduler = createRestartScheduler(() => (restarts += 1), timing, clock);
  scheduler.request();
  advance(1000);
  expect(restarts).toBe(1);
  // The first restart ran at 1 s, so the next one is due at 61 s, not one quiet second later.
  scheduler.request();
  advance(59_000);
  expect(restarts).toBe(1);
  advance(1000);
  expect(restarts).toBe(2);
});

test("stopping cancels a pending restart and ignores later requests", () => {
  const { clock, advance } = fakeClock();
  let restarts = 0;
  const scheduler = createRestartScheduler(() => (restarts += 1), timing, clock);
  scheduler.request();
  scheduler.stop();
  scheduler.request();
  advance(120_000);
  expect(restarts).toBe(0);
});
