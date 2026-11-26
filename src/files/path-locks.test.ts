import { expect, test } from "bun:test";
import { ancestorsOf, localPathLocks, lockPlan, webPathLocks } from "./path-locks";

test("the directories above a path, the top one first", () => {
  expect(ancestorsOf("/workspace/src/main.ts")).toEqual(["/workspace", "/workspace/src"]);
  expect(ancestorsOf("/workspace")).toEqual([]);
});

test("a plan takes each path once, exclusive wins, and a folder comes before what is inside it", () => {
  const plan = lockPlan({
    exclusive: ["/workspace/src/b.ts", "/workspace/src"],
    shared: ["/workspace", "/workspace/src", "/workspace/src-old", "/workspace"],
  });
  expect(plan).toEqual([
    { path: "/workspace", mode: "shared" },
    { path: "/workspace/src", mode: "exclusive" },
    { path: "/workspace/src-old", mode: "shared" },
    { path: "/workspace/src/b.ts", mode: "exclusive" },
  ]);
});

test("Web Locks are asked for in plan order, under the workspace's names and modes", async () => {
  const asked: string[] = [];
  const locks = {
    request: ((name: string, options: LockOptions, granted: LockGrantedCallback<unknown>) => {
      asked.push(`${options.mode} ${name}`);
      return Promise.resolve(granted({ name, mode: options.mode ?? "exclusive" } as Lock));
    }) as LockManager["request"],
  };
  const paths = webPathLocks("demo", locks);
  const result = await paths.hold(
    { exclusive: ["/workspace/a/b"], shared: ["/workspace", "/workspace/a"] },
    async () => "done",
  );
  expect(result).toBe("done");
  expect(asked).toEqual([
    "shared sprockt:demo:path:/workspace",
    "shared sprockt:demo:path:/workspace/a",
    "exclusive sprockt:demo:path:/workspace/a/b",
  ]);
});

const later = () => new Promise((resolve) => setTimeout(resolve, 5));

test("writes under one folder share it; a move of the folder waits for them and they wait for it", async () => {
  const paths = localPathLocks();
  const order: string[] = [];
  const write = (name: string) =>
    paths.hold(
      { exclusive: [`/workspace/dir/${name}`], shared: ["/workspace", "/workspace/dir"] },
      async () => {
        order.push(`${name} starts`);
        await later();
        order.push(`${name} ends`);
      },
    );
  const move = () =>
    paths.hold({ exclusive: ["/workspace/dir", "/workspace/moved"], shared: ["/workspace"] }, async () => {
      order.push("move starts");
      await later();
      order.push("move ends");
    });

  await Promise.all([write("a"), write("b"), move(), write("c")]);
  // a and b run together; the move waits for both; c, asked for after the move, waits for it.
  expect(order.slice(0, 2).toSorted()).toEqual(["a starts", "b starts"]);
  expect(order.indexOf("move starts")).toBeGreaterThan(
    Math.max(order.indexOf("a ends"), order.indexOf("b ends")),
  );
  expect(order.indexOf("c starts")).toBeGreaterThan(order.indexOf("move ends"));
});
