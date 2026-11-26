import { expect, test } from "bun:test";
import { latestOnly } from "./latest";

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test("calls during a run make exactly one more run, after it", async () => {
  const gates: PromiseWithResolvers<void>[] = [];
  let active = 0;
  let most = 0;
  const looker = latestOnly(async () => {
    active++;
    most = Math.max(most, active);
    const gate = Promise.withResolvers<void>();
    gates.push(gate);
    await gate.promise;
    active--;
  });

  looker.run();
  looker.run();
  looker.run();
  looker.run();
  await settle();
  expect(gates).toHaveLength(1);
  gates[0]?.resolve();
  await settle();
  // One run for the three calls that came during the first.
  expect(gates).toHaveLength(2);
  gates[1]?.resolve();
  await settle();
  expect(gates).toHaveLength(2);
  expect(most).toBe(1);

  looker.run();
  await settle();
  expect(gates).toHaveLength(3);
  gates[2]?.resolve();
});

test("a run that fails is reported and the next call still runs", async () => {
  const errors: unknown[] = [];
  let runs = 0;
  const looker = latestOnly(
    async () => {
      runs++;
      if (runs === 1) throw new Error("could not read the project");
    },
    (error) => errors.push(error),
  );
  looker.run();
  await settle();
  expect(errors).toHaveLength(1);
  looker.run();
  await settle();
  expect(runs).toBe(2);
});
