import { expect, test } from "bun:test";
import type { Draft } from "./documents";
import { discardRecovered, leaveForRecovery, recovered } from "./recovery";

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

const drafts = (entries: Record<string, Draft>) => new Map(Object.entries(entries));

test("text left by one tab is found per file and per workspace", () => {
  const storage = memoryStorage();
  leaveForRecovery(storage, "ws1", drafts({ "a.txt": { text: "unsaved", baseText: "A" } }));
  leaveForRecovery(storage, "ws1", drafts({ "src/b.txt": { text: "new file" } }));

  expect(recovered(storage, "ws2", "a.txt")).toBeUndefined();
  expect(recovered(storage, "ws1", "a.txt")).toEqual({ text: "unsaved", baseText: "A" });
  expect(recovered(storage, "ws1", "src/b.txt")).toEqual({ text: "new file" });
});

test("opening a file does not remove its recovered text; a reload still finds it", () => {
  const storage = memoryStorage();
  leaveForRecovery(storage, "ws1", drafts({ "a.txt": { text: "unsaved", baseText: "A" } }));
  expect(recovered(storage, "ws1", "a.txt")).toEqual({ text: "unsaved", baseText: "A" });
  expect(recovered(storage, "ws1", "a.txt")).toEqual({ text: "unsaved", baseText: "A" });

  discardRecovered(storage, "ws1", "a.txt");
  expect(recovered(storage, "ws1", "a.txt")).toBeUndefined();
  expect(storage.items.size).toBe(0);
});

test("a file named like an object property has no text unless some was left", () => {
  const storage = memoryStorage();
  for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    expect(recovered(storage, "ws1", name)).toBeUndefined();
  }
  leaveForRecovery(storage, "ws1", drafts({ constructor: { text: "class body" } }));
  expect(recovered(storage, "ws1", "constructor")).toEqual({ text: "class body" });
  expect(recovered(storage, "ws1", "toString")).toBeUndefined();
});

test("two tabs leaving text for different files do not overwrite each other", () => {
  const storage = memoryStorage();
  // Each tab writes only its own entries; neither rewrites a list the other one read earlier.
  leaveForRecovery(storage, "ws1", drafts({ "a.txt": { text: "from tab one" } }));
  leaveForRecovery(storage, "ws1", drafts({ "b.txt": { text: "from tab two" } }));
  discardRecovered(storage, "ws1", "a.txt");
  expect(recovered(storage, "ws1", "b.txt")).toEqual({ text: "from tab two" });
});

test("damaged data in storage is ignored", () => {
  const storage = memoryStorage();
  storage.setItem("sprockt:recovery:v1:ws1:a.txt", "{not json");
  storage.setItem("sprockt:recovery:v1:ws1:b.txt", JSON.stringify({ text: 5 }));
  expect(recovered(storage, "ws1", "a.txt")).toBeUndefined();
  expect(recovered(storage, "ws1", "b.txt")).toBeUndefined();
});
