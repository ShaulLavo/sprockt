import { beforeEach, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import type { FileChange } from "../files/service";
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

/** A store over an in-memory disk, with `emit` standing in for FileService change events. */
function setUpStore(files: Record<string, string>) {
  const disk = new Map(Object.entries(files));
  const listeners = new Set<(change: FileChange) => void>();
  const workspace = {
    id: "test",
    files: {
      read: async (path: string) => disk.get(path),
      writeIfUnchanged: async () => ({ written: true as const }),
      saved: async () => {},
      revision: () => 0,
      writable: () => true,
      subscribe(listener: (change: FileChange) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
  const emit = (change: Partial<FileChange>) => {
    const full: FileChange = { paths: [], reset: false, moves: [], removed: [], ...change };
    for (const listener of listeners) listener(full);
  };
  return { store: createRoot(() => createEditorStore(workspace)), disk, emit };
}

const storeWith = (files: Record<string, string>) => setUpStore(files).store;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

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

test("a folder moved through FileService takes its open files along, unsaved text and undo too", async () => {
  const { store, disk, emit } = setUpStore({ "docs/a.txt": "a", "docs/b.txt": "b" });
  store.open("docs/a.txt");
  await store.buffers.load("docs/a.txt");
  store.setDisplayed("docs/a.txt");
  type(store, "docs/a.txt", "unsaved ");
  disk.set("moved/a.txt", "a");
  disk.set("moved/b.txt", "b");
  disk.delete("docs/a.txt");
  disk.delete("docs/b.txt");
  emit({
    moves: [
      { from: "docs", to: "moved" },
      { from: "docs/a.txt", to: "moved/a.txt" },
      { from: "docs/b.txt", to: "moved/b.txt" },
    ],
  });
  await tick();
  expect(store.tabs().map((tab) => tab.path)).toEqual(["moved/a.txt"]);
  expect(store.active()).toBe("moved/a.txt");
  expect(store.displayed()).toBe("moved/a.txt");
  const buffer = store.buffers.get("moved/a.txt");
  expect(buffer?.session.materializeFullText()).toBe("unsaved a");
  expect(buffer?.dirty()).toBe(true);
  expect(buffer?.missing()).toBe(false);
  expect(buffer?.conflict()).toBeUndefined();
  buffer?.session.undo();
  expect(buffer?.session.materializeFullText()).toBe("a");
});

test("a read that started before a move does not mark the moved file deleted", async () => {
  const { store, disk, emit } = setUpStore({ "a.txt": "a" });
  store.open("a.txt");
  await store.buffers.load("a.txt");
  type(store, "a.txt", "unsaved ");
  disk.set("b.txt", "a");
  disk.delete("a.txt");
  // The revision sync reads the old path, and the move arrives before that read finishes.
  const syncing = store.buffers.sync();
  emit({ moves: [{ from: "a.txt", to: "b.txt" }] });
  await syncing;
  await tick();
  const buffer = store.buffers.get("b.txt");
  expect(buffer?.missing()).toBe(false);
  expect(buffer?.conflict()).toBeUndefined();
  expect(buffer?.session.materializeFullText()).toBe("unsaved a");
});

test("deleted files keep their tabs and unsaved text, marked deleted", async () => {
  const { store, disk, emit } = setUpStore({ "docs/a.txt": "a", "top.txt": "t" });
  store.open("docs/a.txt");
  await store.buffers.load("docs/a.txt");
  type(store, "docs/a.txt", "unsaved ");
  store.open("top.txt");
  await store.buffers.load("top.txt");
  disk.delete("docs/a.txt");
  emit({ removed: ["docs", "docs/a.txt"] });
  const buffer = store.buffers.get("docs/a.txt");
  expect(buffer?.missing()).toBe(true);
  expect(buffer?.session.materializeFullText()).toBe("unsaved a");
  expect(store.tabs().map((tab) => tab.path)).toEqual(["docs/a.txt", "top.txt"]);
  expect(store.buffers.get("top.txt")?.missing()).toBe(false);
});

test("moves the explorer already applied are not applied again when their event arrives", async () => {
  const { store, disk, emit } = setUpStore({ "a.txt": "same", "c.txt": "same" });
  store.open("a.txt");
  store.open("c.txt");
  await store.buffers.load("a.txt");
  await store.buffers.load("c.txt");
  type(store, "c.txt", "draft ");
  // The explorer renames a.txt to b.txt, then the edited c.txt to a.txt, following each at once.
  disk.set("b.txt", "same");
  disk.set("a.txt", "same");
  disk.delete("c.txt");
  store.rename("a.txt", "b.txt");
  store.rename("c.txt", "a.txt");
  // One coalesced event then reports both moves.
  emit({
    moves: [
      { from: "a.txt", to: "b.txt" },
      { from: "c.txt", to: "a.txt" },
    ],
  });
  await tick();
  expect(store.buffers.get("a.txt")?.session.materializeFullText()).toBe("draft same");
  expect(store.buffers.get("b.txt")?.session.materializeFullText()).toBe("same");
  expect(store.hasUnsaved("b.txt")).toBe(false);
});

test("a folder moved onto a deleted folder whose file had unsaved text keeps both files open", async () => {
  const { store, disk, emit } = setUpStore({ "target/a.txt": "old", "src/a.txt": "new" });
  store.open("target/a.txt");
  await store.buffers.load("target/a.txt");
  type(store, "target/a.txt", "draft ");
  disk.delete("target/a.txt");
  emit({ removed: ["target", "target/a.txt"] });
  store.open("src/a.txt");
  await store.buffers.load("src/a.txt");
  disk.set("target/a.txt", "new");
  disk.delete("src/a.txt");
  emit({
    moves: [
      { from: "src", to: "target" },
      { from: "src/a.txt", to: "target/a.txt" },
    ],
  });
  await tick();
  expect(store.tabs().map((tab) => tab.path)).toEqual(["target/a (unsaved).txt", "target/a.txt"]);
  expect(store.active()).toBe("target/a.txt");
  expect(store.buffers.get("target/a (unsaved).txt")?.session.materializeFullText()).toBe("draft old");
  expect(store.hasUnsaved("target/a (unsaved).txt")).toBe(true);
  expect(store.buffers.get("target/a.txt")?.session.materializeFullText()).toBe("new");
});
