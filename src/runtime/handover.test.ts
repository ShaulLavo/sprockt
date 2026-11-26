import { expect, test } from "bun:test";
import { bootUntilHandedOver } from "./handover";

test("closing the workbench after boot leaves the runtime to its owner", async () => {
  let disposals = 0;
  const dispose = async () => void disposals++;
  const closed = new AbortController();
  const runtime = await bootUntilHandedOver(closed.signal, dispose, async () => "runtime");
  expect(runtime).toBe("runtime");

  // The session disposes the runtime only after what depends on its storage (a pending preview
  // identity claim) has settled: a close must not release the storage behind its back.
  closed.abort();
  await Promise.resolve();
  expect(disposals).toBe(0);
});

test("closing the workbench while it boots disposes at once and fails the boot", async () => {
  let disposals = 0;
  const dispose = async () => void disposals++;
  const closed = new AbortController();
  const step = Promise.withResolvers<void>();
  const booting = bootUntilHandedOver(closed.signal, dispose, async () => {
    await step.promise;
    return "runtime";
  });

  closed.abort();
  await Promise.resolve();
  expect(disposals).toBe(1);
  step.resolve();
  await expect(booting).rejects.toThrow();
});

test("a boot that fails disposes what it built", async () => {
  let disposals = 0;
  const dispose = async () => void disposals++;
  const booting = bootUntilHandedOver(undefined, dispose, async () => {
    throw new Error("no storage");
  });
  await expect(booting).rejects.toThrow("no storage");
  expect(disposals).toBe(1);
});
