import { expect, test } from "bun:test";
import { createEffect, createMemo, createReaction, createRoot, createSignal, on } from "./reactive";

test("a reaction that first reads a stale memo is still told about later changes", () => {
  const [items, setItems] = createSignal<readonly string[]>([]);
  const count = createMemo(() => items().length);
  let invalidations = 0;
  const reaction = createReaction(() => invalidations++);
  const read = () => [items(), count()] as const;
  reaction.track(read);
  setItems(["a"]);
  expect(invalidations).toBe(1);
  // Re-tracking reads `count`, which recomputes now that `items` changed.
  expect(reaction.track(read)[1]).toBe(1);
  setItems(["a", "b"]);
  expect(invalidations).toBe(2);
  expect(reaction.track(read)[1]).toBe(2);
});

test("an effect skips a run when the memo it reads keeps its value", () => {
  const [value, setValue] = createSignal(1);
  const runs: number[] = [];
  // Effects created in a root first run when the root returns.
  const dispose = createRoot((end) => {
    const parity = createMemo(() => value() % 2);
    createEffect(() => runs.push(parity()));
    return end;
  });
  setValue(3);
  expect(runs).toEqual([1]);
  setValue(4);
  expect(runs).toEqual([1, 0]);
  dispose();
});

test("on with defer skips the first run, and a disposed effect stops", () => {
  const [value, setValue] = createSignal("a");
  const seen: string[] = [];
  const dispose = createRoot((end) => {
    createEffect(on(value, (input) => void seen.push(input), { defer: true }));
    return end;
  });
  expect(seen).toEqual([]);
  setValue("b");
  expect(seen).toEqual(["b"]);
  dispose();
  setValue("c");
  expect(seen).toEqual(["b"]);
});
