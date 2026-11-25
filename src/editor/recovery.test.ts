import { expect, test } from "bun:test";
import { leaveForRecovery, takeRecovered } from "./recovery";

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

test("text left by one tab is taken once, per file and per workspace", () => {
  const storage = memoryStorage();
  leaveForRecovery(storage, "ws1", { "a.txt": { text: "unsaved", baseText: "A" } });
  leaveForRecovery(storage, "ws1", { "b.txt": { text: "new file", baseText: undefined } });

  expect(takeRecovered(storage, "ws2", "a.txt")).toBeUndefined();
  expect(takeRecovered(storage, "ws1", "a.txt")).toEqual({ text: "unsaved", baseText: "A" });
  expect(takeRecovered(storage, "ws1", "a.txt")).toBeUndefined();
  expect(takeRecovered(storage, "ws1", "b.txt")).toEqual({ text: "new file" });
  expect(storage.items.size).toBe(0);
});

test("nothing to recover leaves storage untouched", () => {
  const storage = memoryStorage();
  leaveForRecovery(storage, "ws1", {});
  expect(storage.items.size).toBe(0);
});

test("damaged or foreign data in storage is ignored", () => {
  const storage = memoryStorage();
  storage.setItem("sprockt:recovery:ws1", "{not json");
  expect(takeRecovered(storage, "ws1", "a.txt")).toBeUndefined();
  storage.setItem("sprockt:recovery:ws1", JSON.stringify({ "a.txt": { text: 5 }, "b.txt": { text: "ok" } }));
  expect(takeRecovered(storage, "ws1", "a.txt")).toBeUndefined();
  expect(takeRecovered(storage, "ws1", "b.txt")).toEqual({ text: "ok" });
});
