import { expect, test } from "bun:test";
import { createTurnstile, tearDownAll } from "./lifecycle";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeSession(log: string[], name: string) {
  const disposing = Promise.withResolvers<void>();
  return {
    disposing,
    session: {
      dispose() {
        log.push(`dispose ${name} started`);
        return disposing.promise.then(() => void log.push(`dispose ${name} finished`));
      },
    },
  };
}

test("a workspace closed while it is still starting is disposed when it arrives", async () => {
  const log: string[] = [];
  const turnstile = createTurnstile();
  const starting = Promise.withResolvers<ReturnType<typeof fakeSession>["session"]>();
  const first = fakeSession(log, "first");

  const opening = turnstile.open(() => starting.promise);
  const closed = opening.close();
  await tick();
  expect(log).toEqual([]);

  starting.resolve(first.session);
  await tick();
  expect(log).toEqual(["dispose first started"]);
  first.disposing.resolve();
  await closed;
  expect(log).toEqual(["dispose first started", "dispose first finished"]);
});

test("the next workspace starts only after the previous one is fully torn down", async () => {
  const log: string[] = [];
  const turnstile = createTurnstile();
  const first = fakeSession(log, "first");
  const second = fakeSession(log, "second");

  const one = turnstile.open(async () => first.session);
  await one.session;
  void one.close();
  const two = turnstile.open(async () => {
    log.push("start second");
    return second.session;
  });
  await tick();
  expect(log).toEqual(["dispose first started"]);

  first.disposing.resolve();
  await two.session;
  expect(log).toEqual(["dispose first started", "dispose first finished", "start second"]);
});

test("a start that fails, or a dispose that fails, does not block the next workspace", async () => {
  const turnstile = createTurnstile();
  const failed = turnstile.open<{ dispose(): Promise<void> }>(async () => {
    throw new Error("boot failed");
  });
  await expect(failed.session).rejects.toThrow("boot failed");
  await failed.close();

  const broken = turnstile.open(async () => ({ dispose: () => Promise.reject(new Error("dispose failed")) }));
  await broken.session;
  await broken.close();

  const next = turnstile.open(async () => ({ dispose: async () => {} }));
  await expect(next.session).resolves.toBeDefined();
});

test("idle() resolves only once the open workspace was closed", async () => {
  const turnstile = createTurnstile();
  const opening = turnstile.open(async () => ({ dispose: async () => {} }));
  let idle = false;
  void turnstile.idle().then(() => (idle = true));
  await tick();
  expect(idle).toBe(false);
  await opening.close();
  await tick();
  expect(idle).toBe(true);
});

test("every teardown step runs even when an earlier one fails, and the failure is reported", async () => {
  const ran: string[] = [];
  const steps = [
    () => void ran.push("files"),
    () => Promise.reject(new Error("preview transport broke")),
    async () => void ran.push("runtime"),
  ];
  await expect(tearDownAll(steps)).rejects.toThrow("preview transport broke");
  expect(ran).toEqual(["files", "runtime"]);
});
