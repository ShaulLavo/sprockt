import { beforeEach, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import type { FileChange } from "../files/service";
import { isDetached, originalPath } from "./buffers";
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
  const writes: string[] = [];
  const listeners = new Set<(change: FileChange) => void>();
  const workspace = {
    id: "test",
    files: {
      read: async (path: string) => disk.get(path),
      async writeIfUnchanged(path: string, content: string, expected: string | undefined) {
        const current = disk.get(path);
        if (current !== expected) return { written: false as const, current };
        writes.push(path);
        disk.set(path, content);
        return { written: true as const };
      },
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
  return { store: createRoot(() => createEditorStore(workspace)), disk, emit, writes };
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
      { from: "docs", to: "moved", operation: 1 },
      { from: "docs/a.txt", to: "moved/a.txt", operation: 1 },
      { from: "docs/b.txt", to: "moved/b.txt", operation: 1 },
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
  emit({ moves: [{ from: "a.txt", to: "b.txt", operation: 1 }] });
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

test("each move operation is applied once and in order, whatever the event stream repeats", async () => {
  const { store, disk, emit } = setUpStore({ "a.txt": "same", "c.txt": "same" });
  store.open("a.txt");
  store.open("c.txt");
  await store.buffers.load("a.txt");
  await store.buffers.load("c.txt");
  type(store, "c.txt", "draft ");
  // a.txt moves to b.txt, then the edited c.txt moves to a.txt.
  disk.set("b.txt", "same");
  disk.set("a.txt", "same");
  disk.delete("c.txt");
  const first = { from: "a.txt", to: "b.txt", operation: 1 };
  const second = { from: "c.txt", to: "a.txt", operation: 2 };
  emit({ moves: [first, second] });
  // The same operations arriving again (a late or repeated batch) change nothing.
  emit({ moves: [first] });
  emit({ moves: [first, second] });
  await tick();
  expect(store.buffers.get("a.txt")?.session.materializeFullText()).toBe("draft same");
  expect(store.buffers.get("b.txt")?.session.materializeFullText()).toBe("same");
  expect(store.hasUnsaved("b.txt")).toBe(false);
});

test("a later move between the same paths is applied, and a folder's file list is covered by the folder", async () => {
  const { store, disk, emit } = setUpStore({ "src/x.txt": "old", "dst/keep.txt": "k" });
  store.open("src/x.txt");
  await store.buffers.load("src/x.txt");
  // Operation 1 moves the folder, listing its file. Operation 2 moves dst/x.txt away.
  disk.set("dst/x.txt", "old");
  disk.delete("src/x.txt");
  emit({
    moves: [
      { from: "src", to: "dst", operation: 1 },
      { from: "src/x.txt", to: "dst/x.txt", operation: 1 },
    ],
  });
  expect(store.tabs().map((tab) => tab.path)).toEqual(["dst/x.txt"]);
  disk.set("away.txt", "old");
  disk.delete("dst/x.txt");
  emit({ moves: [{ from: "dst/x.txt", to: "away.txt", operation: 2 }] });
  // A new src/x.txt is created, edited, and moved to dst/x.txt: same paths as before, new operation.
  disk.set("src/x.txt", "new");
  store.open("src/x.txt");
  await store.buffers.load("src/x.txt");
  type(store, "src/x.txt", "draft ");
  disk.set("dst/x.txt", "new");
  disk.delete("src/x.txt");
  emit({ moves: [{ from: "src/x.txt", to: "dst/x.txt", operation: 3 }] });
  await tick();
  expect(store.buffers.get("dst/x.txt")?.session.materializeFullText()).toBe("draft new");
  expect(store.buffers.get("away.txt")?.session.materializeFullText()).toBe("old");
  expect(store.buffers.get("src/x.txt")).toBeUndefined();
});

test("a move only points a buffer elsewhere: different text there under unsaved edits is a conflict", async () => {
  const { store, disk, emit, writes } = setUpStore({ "a.txt": "base", "b.txt": "other" });
  store.open("a.txt");
  await store.buffers.load("a.txt");
  type(store, "a.txt", "draft ");
  // The file that ends up at b.txt is not the one the buffer was read from.
  disk.delete("a.txt");
  emit({ moves: [{ from: "a.txt", to: "b.txt", operation: 1 }] });
  await tick();
  await tick();
  const buffer = store.buffers.get("b.txt");
  expect(buffer?.session.materializeFullText()).toBe("draft base");
  expect(buffer?.conflict()).toEqual({ diskText: "other" });
  expect(writes).toEqual([]);
});

test("a save made while a move holds the lock waits and writes to the moved path", async () => {
  const { store, disk, emit, writes } = setUpStore({ "a.txt": "base" });
  store.open("a.txt");
  await store.buffers.load("a.txt");
  store.setDisplayed("a.txt");
  type(store, "a.txt", "draft ");
  const lock = await store.lockPaths(["a.txt", "b.txt"]);
  const saving = store.save("a.txt");
  await tick();
  expect(writes).toEqual([]);
  // The explorer's move runs, then releases its lock; saves still wait for the move's event.
  disk.set("b.txt", "base");
  disk.delete("a.txt");
  lock.release(true);
  await tick();
  expect(writes).toEqual([]);
  emit({ moves: [{ from: "a.txt", to: "b.txt", operation: 1 }] });
  await saving;
  expect(writes).toEqual(["b.txt"]);
  expect(disk.get("b.txt")).toBe("draft base");
  expect(disk.has("a.txt")).toBe(false);
});

test("a folder moved onto a deleted folder with an unsaved file keeps that draft apart, at no real path", async () => {
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
      { from: "src", to: "target", operation: 1 },
      { from: "src/a.txt", to: "target/a.txt", operation: 1 },
    ],
  });
  await tick();
  const [aside, incoming] = store.tabs().map((tab) => tab.path);
  expect(incoming).toBe("target/a.txt");
  expect(aside !== undefined && isDetached(aside)).toBe(true);
  expect(originalPath(aside as string)).toBe("target/a.txt");
  expect(store.buffers.get(aside as string)?.session.materializeFullText()).toBe("draft old");
  expect(store.buffers.get("target/a.txt")?.session.materializeFullText()).toBe("new");
  // A file that happens to be named like a free name is still just that file.
  disk.set("target/a (draft).txt", "someone else's");
  // Saving the detached draft picks a free name at that moment.
  await store.save(aside);
  expect(disk.get("target/a (draft 2).txt")).toBe("draft old");
  expect(disk.get("target/a (draft).txt")).toBe("someone else's");
  expect(store.tabs().map((tab) => tab.path)).toContain("target/a (draft 2).txt");
});
