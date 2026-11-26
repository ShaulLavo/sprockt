import { expect, test } from "bun:test";
import {
  createDraftKeeper,
  draftKey,
  draftsLeftFor,
  leaveForRecovery,
  pickRecovered,
  type Draft,
} from "./recovery";
import { renamedPath } from "./tabs";

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
    key: (index: number) => Array.from(items.keys())[index] ?? null,
    get length() {
      return items.size;
    },
  };
}

/** Web Locks as far as tab leases use them: exclusive names held until the callback settles. */
function memoryLocks() {
  const held = new Set<string>();
  return {
    held,
    request(name: string, callback: () => Promise<void>) {
      held.add(name);
      return callback().finally(() => held.delete(name));
    },
    // Like the browser's, the answer comes later, after locks let go meanwhile were released.
    query: () =>
      new Promise((resolve) =>
        setTimeout(() => resolve({ held: Array.from(held, (name) => ({ name })) }), 0),
      ),
  } as unknown as LockManager & { held: Set<string> };
}

const drafts = (entries: Record<string, Draft>) => new Map(Object.entries(entries));

function keeper(
  storage: ReturnType<typeof memoryStorage>,
  locks: LockManager,
  tab: string,
  workspace = "ws1",
) {
  return createDraftKeeper({ storage, workspace, tab, locks, renamedPath });
}

test("text a closed tab left is found per file and per workspace", async () => {
  const storage = memoryStorage();
  const locks = memoryLocks();
  const gone = keeper(storage, locks, "tab-1");
  gone.leave(drafts({ "a.txt": { text: "unsaved", baseText: "A" }, "src/b.txt": { text: "new file" } }));
  gone.release();

  const next = keeper(storage, locks, "tab-2");
  expect(await keeper(storage, locks, "tab-3", "ws2").recover("a.txt")).toBeUndefined();
  expect(await next.recover("a.txt")).toEqual({ text: "unsaved", baseText: "A" });
  expect(await next.recover("src/b.txt")).toEqual({ text: "new file", baseText: undefined });
});

test("a live tab's text is its own: another tab does not take it", async () => {
  const storage = memoryStorage();
  const locks = memoryLocks();
  const hidden = keeper(storage, locks, "tab-1");
  hidden.leave(drafts({ "a.txt": { text: "mine", baseText: "A" } }));
  const other = keeper(storage, locks, "tab-2");
  expect(await other.recover("a.txt")).toBeUndefined();
  // Once it is gone, the text is free.
  hidden.release();
  expect(await other.recover("a.txt")).toEqual({ text: "mine", baseText: "A" });
});

test("two tabs leaving text for the same file keep both; the newest is offered first", async () => {
  const storage = memoryStorage();
  const locks = memoryLocks();
  const one = keeper(storage, locks, "tab-1");
  const two = keeper(storage, locks, "tab-2");
  leaveForRecovery(storage, "ws1", "tab-1", drafts({ "a.txt": { text: "from one", baseText: "A" } }), 1);
  leaveForRecovery(storage, "ws1", "tab-2", drafts({ "a.txt": { text: "from two", baseText: "A" } }), 2);
  expect(
    draftsLeftFor(storage, "ws1", "a.txt")
      .map((draft) => draft.text)
      .toSorted(),
  ).toEqual(["from one", "from two"]);
  one.release();
  two.release();

  const next = keeper(storage, locks, "tab-3");
  expect((await next.recover("a.txt"))?.text).toBe("from two");
  next.settled("a.txt");
  // The other tab's text was not dropped with it.
  expect((await next.recover("a.txt"))?.text).toBe("from one");
});

test("leaving again replaces what the tab left before; other tabs' entries stay", () => {
  const storage = memoryStorage();
  leaveForRecovery(storage, "ws1", "tab-1", drafts({ "a.txt": { text: "a" }, "b.txt": { text: "b" } }));
  leaveForRecovery(storage, "ws1", "tab-2", drafts({ "a.txt": { text: "other" } }));
  leaveForRecovery(storage, "ws1", "tab-1", drafts({ "b.txt": { text: "b2" } }));
  expect(Array.from(storage.items.keys()).toSorted()).toEqual(
    [draftKey("ws1", "a.txt", "tab-2"), draftKey("ws1", "b.txt", "tab-1")].toSorted(),
  );
});

test("settling a file removes this tab's entry and those it took, not a live tab's", async () => {
  const storage = memoryStorage();
  const locks = memoryLocks();
  const gone = keeper(storage, locks, "tab-1");
  gone.leave(drafts({ "a.txt": { text: "left" } }));
  gone.release();
  const live = keeper(storage, locks, "tab-2");
  live.leave(drafts({ "a.txt": { text: "live tab's" } }));

  const mine = keeper(storage, locks, "tab-3");
  expect((await mine.recover("a.txt"))?.text).toBe("left");
  // Opening it does not use it up.
  expect((await mine.recover("a.txt"))?.text).toBe("left");
  mine.leave(drafts({ "a.txt": { text: "left" } }));
  mine.settled("a.txt");
  expect(Array.from(storage.items.keys())).toEqual([draftKey("ws1", "a.txt", "tab-2")]);
});

test("entries follow a move this tab saw", async () => {
  const storage = memoryStorage();
  const locks = memoryLocks();
  const gone = keeper(storage, locks, "tab-1");
  gone.leave(drafts({ "docs/a.txt": { text: "taken" } }));
  gone.release();
  const tab = keeper(storage, locks, "tab-2");
  await tab.recover("docs/a.txt");
  tab.leave(drafts({ "docs/b.txt": { text: "own" } }));
  tab.renamed("docs", "moved");
  expect(storage.items.has(draftKey("ws1", "moved/b.txt", "tab-2"))).toBe(true);
  expect(storage.items.has(draftKey("ws1", "docs/b.txt", "tab-2"))).toBe(false);
  tab.settled("moved/a.txt");
  expect(storage.items.has(draftKey("ws1", "docs/a.txt", "tab-1"))).toBe(false);
});

test("pickRecovered takes every free entry with the same text, and skips held ones", () => {
  const left = [
    { key: "k1", tab: "t1", at: 1, text: "same", baseText: "A" },
    { key: "k2", tab: "t2", at: 3, text: "same", baseText: "A" },
    { key: "k3", tab: "t3", at: 2, text: "different", baseText: "A" },
    { key: "k4", tab: "t4", at: 9, text: "held", baseText: "A" },
  ];
  expect(pickRecovered(left, (tab) => tab === "t4")).toEqual({
    draft: { text: "same", baseText: "A" },
    keys: ["k2", "k1"],
  });
  expect(pickRecovered(left, () => true)).toBeUndefined();
});

test("a file named like an object property, and damaged data, give nothing", async () => {
  const storage = memoryStorage();
  const tab = keeper(storage, undefined as unknown as LockManager, "tab-1");
  const names = ["constructor", "toString", "__proto__"];
  expect(await Promise.all(names.map((name) => tab.recover(name)))).toEqual([
    undefined,
    undefined,
    undefined,
  ]);
  storage.setItem(draftKey("ws1", "a.txt", "x"), "{not json");
  storage.setItem(draftKey("ws1", "b.txt", "x"), JSON.stringify({ text: 5, at: 1 }));
  expect(await tab.recover("a.txt")).toBeUndefined();
  expect(await tab.recover("b.txt")).toBeUndefined();
});

test("full or blocked storage never throws", () => {
  const blocked = {
    getItem: () => null,
    setItem: () => {
      throw new DOMException("full", "QuotaExceededError");
    },
    removeItem: () => {},
    key: () => null,
    length: 0,
  };
  expect(() => leaveForRecovery(blocked, "ws1", "t", drafts({ "a.txt": { text: "x" } }))).not.toThrow();
});

test("settled with an earlier version or different buffer keeps a left draft until a matching covering version settles", () => {
  const storage = memoryStorage();
  const locks = memoryLocks();
  const tab = keeper(storage, locks, "tab-1");
  tab.leave(
    drafts({ "a.txt": { text: "A+B", baseText: "base" } }),
    new Map([["a.txt", { buffer: 1, version: 2 }]]),
  );

  tab.settled("a.txt", { buffer: 1, version: 1 });
  expect(storage.items.has(draftKey("ws1", "a.txt", "tab-1"))).toBe(true);

  // A flush from a different buffer with a higher version must not clear this buffer's draft.
  tab.settled("a.txt", { buffer: 2, version: 9 });
  expect(storage.items.has(draftKey("ws1", "a.txt", "tab-1"))).toBe(true);

  tab.settled("a.txt", { buffer: 1, version: 2 });
  expect(storage.items.has(draftKey("ws1", "a.txt", "tab-1"))).toBe(false);
});

test("recoverablePaths finds unclaimed matching drafts and skips live tabs", async () => {
  const storage = memoryStorage();
  const locks = memoryLocks();
  const gone = keeper(storage, locks, "tab-1");
  gone.leave(drafts({ "\u0000unsaved:1/a.txt": { text: "from gone" }, "normal.txt": { text: "n" } }));
  gone.release();
  const live = keeper(storage, locks, "tab-2");
  live.leave(drafts({ "\u0000unsaved:2/b.txt": { text: "from live" } }));

  const next = keeper(storage, locks, "tab-3");
  expect(await next.recoverablePaths((path) => path.startsWith("\u0000"))).toEqual(["\u0000unsaved:1/a.txt"]);
  live.release();
  expect((await next.recoverablePaths((path) => path.startsWith("\u0000"))).toSorted()).toEqual([
    "\u0000unsaved:1/a.txt",
    "\u0000unsaved:2/b.txt",
  ]);
});
