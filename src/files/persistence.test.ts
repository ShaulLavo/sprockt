import { expect, test } from "bun:test";
import { createPersistence, type SaveState } from "./persistence";

/** A flush the test finishes by hand, so the moments before and after it can be observed. */
function manualFlush() {
  const pending: PromiseWithResolvers<void>[] = [];
  return {
    flush() {
      const next = Promise.withResolvers<void>();
      pending.push(next);
      return next.promise;
    },
    get started() {
      return pending.length;
    },
    async finish(index: number, error?: Error) {
      if (error) pending[index]?.reject(error);
      else pending[index]?.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

test("a change is `saving` at once and `saved` only after its flush finished", async () => {
  const storage = manualFlush();
  const states: SaveState[] = [];
  const persistence = createPersistence(storage.flush, (state) => states.push(state));

  persistence.touch();
  expect(persistence.state).toBe("saving");
  expect(storage.started).toBe(1);

  await storage.finish(0);
  expect(persistence.state).toBe("saved");
  expect(states.at(-1)).toBe("saved");
});

test("a write in flight is `saving` before it was acknowledged", () => {
  const storage = manualFlush();
  const persistence = createPersistence(storage.flush, () => {});
  const end = persistence.begin();
  expect(persistence.state).toBe("saving");
  end();
  expect(persistence.state).toBe("saved");
  expect(storage.started).toBe(0);
});

test("a change during a flush keeps `saving` until a flush that started after it finished", async () => {
  const storage = manualFlush();
  const persistence = createPersistence(storage.flush, () => {});
  persistence.touch();
  persistence.touch();
  expect(storage.started).toBe(1);

  await storage.finish(0);
  expect(persistence.state).toBe("saving");
  expect(storage.started).toBe(2);

  await storage.finish(1);
  expect(persistence.state).toBe("saved");
});

test("settled() resolves with the flush that covers the change, not before", async () => {
  const storage = manualFlush();
  const persistence = createPersistence(storage.flush, () => {});
  persistence.touch();
  let settled = false;
  const waiting = persistence.settled().then(() => (settled = true));
  await Promise.resolve();
  expect(settled).toBe(false);
  await storage.finish(0);
  await waiting;
  expect(settled).toBe(true);
});

test("a failed flush is `failed`, rejects settled(), and the next change tries again", async () => {
  const storage = manualFlush();
  const persistence = createPersistence(storage.flush, () => {});
  persistence.touch();
  const waiting = persistence.settled().then(
    () => "settled",
    (error: Error) => error.message,
  );
  await storage.finish(0, new Error("quota exceeded"));
  expect(persistence.state).toBe("failed");
  expect(await waiting).toBe("quota exceeded");

  persistence.touch();
  expect(persistence.state).toBe("saving");
  await storage.finish(1);
  expect(persistence.state).toBe("saved");
});

test("after stop() nothing is flushed again and the state stays `failed`", async () => {
  const storage = manualFlush();
  const persistence = createPersistence(storage.flush, () => {});
  persistence.stop(new Error("moved to another tab"));
  persistence.touch();
  expect(persistence.state).toBe("failed");
  expect(storage.started).toBe(0);
  await expect(persistence.settled()).rejects.toThrow("moved to another tab");
});
