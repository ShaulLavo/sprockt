import { expect, test } from "bun:test";
import { localPathLocks, webPathLocks } from "./path-locks";

/** Exclusive, FIFO, records the order locks are asked for. */
function fakeLocks() {
  const asked: string[] = [];
  const tails = new Map<string, Promise<unknown>>();
  const request = ((name: string, _options: LockOptions, granted: LockGrantedCallback<unknown>) => {
    asked.push(name);
    const run = (tails.get(name) ?? Promise.resolve()).then(() =>
      granted({ name, mode: "exclusive" } as Lock),
    );
    tails.set(
      name,
      run.catch(() => {}),
    );
    return run;
  }) as LockManager["request"];
  return { asked, locks: { request } };
}

test("several paths are locked one at a time in sorted order, under the workspace's names", async () => {
  const { asked, locks } = fakeLocks();
  const paths = webPathLocks("demo", locks);
  expect(await paths.hold(["/workspace/b", "/workspace/a", "/workspace/b"], async () => "done")).toBe("done");
  expect(asked).toEqual(["sprockt:demo:path:/workspace/a", "sprockt:demo:path:/workspace/b"]);
});

for (const [name, make] of [
  ["Web Locks", () => webPathLocks("demo", fakeLocks().locks)],
  ["one page", localPathLocks],
] as const) {
  test(`${name}: work on a shared path never overlaps`, async () => {
    const paths = make();
    const order: string[] = [];
    const first = paths.hold(["/workspace/x", "/workspace/y"], async () => {
      order.push("first starts");
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push("first ends");
    });
    const second = paths.hold(["/workspace/y"], async () => {
      order.push("second starts");
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push("second ends");
    });
    await Promise.all([first, second]);
    // Either may go first; one ends before the other starts.
    expect([
      ["first starts", "first ends", "second starts", "second ends"],
      ["second starts", "second ends", "first starts", "first ends"],
    ]).toContainEqual(order);
  });
}
