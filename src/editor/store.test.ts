import { beforeEach, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { createEditorStore } from "./store";

// The store remembers tabs and recovers drafts through localStorage; bun has none.
beforeEach(() => {
  const items = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  } as Storage;
});

function storeWith(files: Record<string, string>) {
  const disk = new Map(Object.entries(files));
  const workspace = {
    id: "test",
    files: {
      read: async (path: string) => disk.get(path),
      writeIfUnchanged: async () => ({ written: true as const }),
      saved: async () => {},
      revision: () => 0,
      writable: () => true,
    },
  };
  return createRoot(() => createEditorStore(workspace));
}

function type(store: ReturnType<typeof createEditorStore>, path: string, text: string): void {
  const session = store.buffers.get(path)?.session;
  if (!session) throw new Error(`${path} is not loaded`);
  session.applyEdits([{ from: 0, to: 0, text }]);
}

test("a preview replaced by the next one releases its buffer", async () => {
  const store = storeWith({ "a.ts": "a", "b.ts": "b", "c.ts": "c" });
  for (const path of ["a.ts", "b.ts", "c.ts"]) {
    store.open(path, { preview: true });
    // oxlint-disable-next-line no-await-in-loop -- each preview loads before the next replaces it
    await store.buffers.load(path);
  }
  expect(store.tabs()).toEqual([{ path: "c.ts", preview: true }]);
  expect(store.buffers.paths()).toEqual(["c.ts"]);
});

test("a preview with unsaved edits is kept as a tab instead of being replaced", async () => {
  const store = storeWith({ "a.ts": "a", "b.ts": "b" });
  store.open("a.ts", { preview: true });
  await store.buffers.load("a.ts");
  type(store, "a.ts", "edited ");
  store.open("b.ts", { preview: true });
  await store.buffers.load("b.ts");
  expect(store.tabs().map((tab) => tab.path)).toEqual(["a.ts", "b.ts"]);
  expect(store.buffers.get("a.ts")?.session.materializeFullText()).toBe("edited a");
  expect(store.hasUnsaved("a.ts")).toBe(true);
});

test("a load that finishes after its tab closed leaves no buffer behind", async () => {
  const store = storeWith({ "a.ts": "a", "b.ts": "b" });
  store.open("b.ts");
  store.open("a.ts");
  const loading = store.buffers.load("a.ts");
  store.close("a.ts");
  await loading;
  store.releaseClosed();
  expect(store.buffers.paths()).toEqual([]);
});

test("a replaced preview still on screen keeps its buffer, and typing in it brings its tab back", async () => {
  const store = storeWith({ "a.ts": "a", "b.ts": "b" });
  store.open("a.ts", { preview: true });
  await store.buffers.load("a.ts");
  store.setDisplayed("a.ts");
  // b.ts is selected but still loading: a.ts is on screen, without a tab.
  store.open("b.ts", { preview: true });
  expect(store.tabs().map((tab) => tab.path)).toEqual(["b.ts"]);
  type(store, "a.ts", "typed ");
  expect(store.tabs()).toEqual([
    { path: "b.ts", preview: true },
    { path: "a.ts", preview: false },
  ]);
  expect(store.hasUnsaved("a.ts")).toBe(true);
  await store.buffers.load("b.ts");
  store.setDisplayed("b.ts");
  expect(store.buffers.get("a.ts")?.session.materializeFullText()).toBe("typed a");
});

test("a replaced preview nobody typed in is released once the next file shows", async () => {
  const store = storeWith({ "a.ts": "a", "b.ts": "b" });
  store.open("a.ts", { preview: true });
  await store.buffers.load("a.ts");
  store.setDisplayed("a.ts");
  store.open("b.ts", { preview: true });
  expect(store.buffers.paths()).toContain("a.ts");
  await store.buffers.load("b.ts");
  store.setDisplayed("b.ts");
  expect(store.buffers.paths()).toEqual(["b.ts"]);
});
