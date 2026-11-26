import { describe, expect, test } from "bun:test";
import { createDemoController, DEMO_SAVED_HMR, type DemoEnvironment } from "./demo";

interface PendingTimer {
  readonly id: number;
  readonly at: number;
  readonly fn: () => void;
}

function createFakeEnv(options: { hidden?: boolean; reduced?: boolean } = {}) {
  let hidden = options.hidden ?? false;
  let reduced = options.reduced ?? false;
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, PendingTimer>();
  const visibilityListeners = new Set<() => void>();
  const reducedListeners = new Set<(next: boolean) => void>();

  const env: DemoEnvironment = {
    isHidden: () => hidden,
    isReduced: () => reduced,
    subscribeVisibility(listener) {
      visibilityListeners.add(listener);
      return () => visibilityListeners.delete(listener);
    },
    subscribeReduced(listener) {
      reducedListeners.add(listener);
      return () => reducedListeners.delete(listener);
    },
    schedule(delayMs, fn) {
      const id = nextId++;
      timers.set(id, { id, at: now + delayMs, fn });
      return () => timers.delete(id);
    },
  };

  function advance(ms: number): void {
    const target = now + ms;
    while (true) {
      let earliest: PendingTimer | undefined;
      for (const timer of timers.values()) {
        if (timer.at <= target && (!earliest || timer.at < earliest.at)) earliest = timer;
      }
      if (!earliest) break;
      timers.delete(earliest.id);
      now = earliest.at;
      earliest.fn();
    }
    now = target;
  }

  return {
    env,
    pendingCount: () => timers.size,
    visibilityListenerCount: () => visibilityListeners.size,
    reducedListenerCount: () => reducedListeners.size,
    advance,
    setHidden(next: boolean) {
      hidden = next;
      for (const listener of visibilityListeners) listener();
    },
    setReduced(next: boolean) {
      reduced = next;
      for (const listener of reducedListeners) listener(next);
    },
  };
}

describe("landing workbench demo lifecycle", () => {
  test("skips queueing timers when mounted hidden and starts cleanly once visible", () => {
    const fake = createFakeEnv({ hidden: true });
    const demo = createDemoController(fake.env);
    demo.start();

    expect(fake.pendingCount()).toBe(0);
    expect(demo.playing()).toBe(false);

    fake.setHidden(false);
    expect(demo.playing()).toBe(true);
    expect(fake.pendingCount()).toBeGreaterThan(0);

    fake.advance(10_000);
    expect(demo.step()).toBe(DEMO_SAVED_HMR);
    expect(demo.playing()).toBe(false);
    expect(fake.pendingCount()).toBe(0);

    demo.dispose();
    expect(fake.visibilityListenerCount()).toBe(0);
    expect(fake.reducedListenerCount()).toBe(0);
  });

  test("hidden mid-playback settles on the finished scene and keeps what was chosen", () => {
    const fake = createFakeEnv({ hidden: false });
    const demo = createDemoController(fake.env);
    demo.start();

    expect(demo.playing()).toBe(true);
    expect(fake.pendingCount()).toBeGreaterThan(0);

    fake.advance(600);
    demo.setActiveFile("App.css");
    demo.setActiveTerm("dev");
    fake.setHidden(true);
    expect(demo.playing()).toBe(false);
    expect(fake.pendingCount()).toBe(0);
    expect(demo.step()).toBe(DEMO_SAVED_HMR);

    // Coming back neither restarts the scene nor drops the chosen file and terminal tab.
    fake.setHidden(false);
    expect(demo.playing()).toBe(false);
    expect(fake.pendingCount()).toBe(0);
    expect(demo.step()).toBe(DEMO_SAVED_HMR);
    expect(demo.activeFile()).toBe("App.css");
    expect(demo.activeTerm()).toBe("dev");

    demo.dispose();
  });

  test("cancels timers immediately when prefers-reduced-motion turns on while mounted", () => {
    const fake = createFakeEnv({ reduced: false });
    const demo = createDemoController(fake.env);
    demo.start();

    expect(demo.playing()).toBe(true);
    expect(demo.reducedMotion()).toBe(false);

    fake.setReduced(true);
    expect(demo.reducedMotion()).toBe(true);
    expect(demo.playing()).toBe(false);
    expect(demo.step()).toBe(DEMO_SAVED_HMR);
    expect(fake.pendingCount()).toBe(0);

    demo.replay();
    expect(demo.playing()).toBe(false);
    expect(fake.pendingCount()).toBe(0);

    demo.dispose();
  });

  test("pause stops playback, clears timers, and does not auto-resume on visibility change", () => {
    const fake = createFakeEnv();
    const demo = createDemoController(fake.env);
    demo.start();

    demo.pause();
    expect(demo.playing()).toBe(false);
    expect(demo.step()).toBe(DEMO_SAVED_HMR);
    expect(fake.pendingCount()).toBe(0);

    fake.setHidden(true);
    fake.setHidden(false);
    expect(demo.playing()).toBe(false);
    expect(fake.pendingCount()).toBe(0);

    demo.dispose();
  });
});
