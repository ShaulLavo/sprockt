import { beforeEach, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import type { FileChange } from "../files/service";
import { ProjectPathError } from "../workspace/paths";
import { isDetached, originalPath } from "./buffers";
import { createEditorStore } from "./store";

// The store remembers tabs and recovers drafts through localStorage; bun has none.
beforeEach(() => {
  const items = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
    key: (index: number) => Array.from(items.keys())[index] ?? null,
    get length() {
      return items.size;
    },
  } as Storage;
});

/** A store over an in-memory disk, with `emit` standing in for FileService change events. */
function setUpStore(files: Record<string, string>, shared?: Map<string, string>) {
  // A second store over `shared` is another tab on the same files.
  const disk = shared ?? new Map(Object.entries(files));
  const writes: string[] = [];
  const listeners = new Set<(change: FileChange) => void>();
  const flushes: PromiseWithResolvers<void>[] = [];
  let holdingFlushes = false;
  const workspace = {
    id: "test",
    files: {
      read: async (path: string) => {
        if (path.includes("\u0000")) throw new ProjectPathError(path, "it contains a NUL");
        return disk.get(path);
      },
      async writeIfUnchanged(path: string, content: string, expected: string | undefined) {
        if (path.includes("\u0000")) throw new ProjectPathError(path, "it contains a NUL");
        const current = disk.get(path);
        if (current !== expected) return { written: false as const, current };
        writes.push(path);
        disk.set(path, content);
        return { written: true as const };
      },
      saved() {
        if (!holdingFlushes) return Promise.resolve();
        const flush = Promise.withResolvers<void>();
        flushes.push(flush);
        return flush.promise;
      },
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
  const { store, dispose } = createRoot((end) => ({ store: createEditorStore(workspace), dispose: end }));
  return {
    store,
    dispose,
    disk,
    emit,
    writes,
    flushes,
    holdFlushes() {
      holdingFlushes = true;
    },
    releaseFlushes() {
      holdingFlushes = false;
    },
  };
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

const recoveryKeys = () =>
  Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index) ?? "").filter((key) =>
    key.startsWith("sprockt:recovery:"),
  );

test("a page hidden while its save waits for a lock leaves the text for the next tab until it is durable", async () => {
  const first = setUpStore({ "a.ts": "a" });
  first.store.open("a.ts");
  await first.store.buffers.load("a.ts");
  type(first.store, "a.ts", "draft ");
  // A move holds the file, so the save the hidden page starts has to wait for it.
  const lock = await first.store.lockPaths(["a.ts"]);
  const hidden = first.store.pageHidden();
  await tick();
  expect(first.disk.get("a.ts")).toBe("a");
  // The page is torn down before it gets the lock back: its save never runs.
  first.dispose();
  lock.release(false);
  await hidden;
  expect(first.disk.get("a.ts")).toBe("a");

  // Another tab opening the file finds the text, unsaved, with no conflict: the disk is as it was.
  const second = setUpStore({}, first.disk);
  second.store.open("a.ts");
  const buffer = await second.store.buffers.load("a.ts");
  expect(buffer?.session.materializeFullText()).toBe("draft a");
  expect(buffer?.dirty()).toBe(true);
  expect(buffer?.conflict()).toBeUndefined();
  expect(recoveryKeys()).toHaveLength(1);

  // Once that tab's save of it is durable, the copy goes.
  await second.store.save("a.ts");
  await tick();
  expect(first.disk.get("a.ts")).toBe("draft a");
  expect(recoveryKeys()).toEqual([]);
  second.dispose();
});

test("a hidden page's copy goes once its own save is durable, and a visible page leaves none", async () => {
  const { store, disk, dispose } = setUpStore({ "a.ts": "a" });
  store.open("a.ts");
  await store.buffers.load("a.ts");
  type(store, "a.ts", "typed ");
  expect(recoveryKeys()).toEqual([]);
  await store.pageHidden();
  await tick();
  expect(disk.get("a.ts")).toBe("typed a");
  expect(recoveryKeys()).toEqual([]);
  dispose();
});

test("an earlier flush finishing does not delete a newer page-hide draft", async () => {
  const first = setUpStore({ "a.ts": "base" });
  first.store.setAutosave(false);
  first.holdFlushes();
  first.store.open("a.ts");
  await first.store.buffers.load("a.ts");
  // Save edit A and hold its flush.
  type(first.store, "a.ts", "A:");
  await first.store.save("a.ts");
  expect(first.disk.get("a.ts")).toBe("A:base");
  expect(first.flushes).toHaveLength(1);

  // Type edit B, then hide the page: recovery stores B+A.
  type(first.store, "a.ts", "B:");
  await first.store.pageHidden();
  expect(recoveryKeys()).toHaveLength(1);

  // Now the earlier flush for A completes: it must NOT delete the newer B+A recovery entry.
  first.flushes.shift()?.resolve();
  await tick();
  expect(recoveryKeys()).toHaveLength(1);
  first.dispose();

  // Reopening in a new tab recovers B+A instead of losing B.
  const second = setUpStore({}, first.disk);
  second.store.open("a.ts");
  const buffer = await second.store.buffers.load("a.ts");
  expect(buffer?.session.materializeFullText()).toBe("B:A:base");
  expect(buffer?.dirty()).toBe(true);
  second.store.setDisplayed("a.ts");
  await second.store.keepMine();
  await tick();
  expect(first.disk.get("a.ts")).toBe("B:A:base");
  expect(recoveryKeys()).toEqual([]);
  second.dispose();
});

test("a detached draft left on page hide opens on reload and is discovered even if another tab wrote the tab list", async () => {
  const first = setUpStore({ "target/a.txt": "old", "src/a.txt": "new", "other.txt": "o" });
  first.store.open("target/a.txt");
  await first.store.buffers.load("target/a.txt");
  type(first.store, "target/a.txt", "draft ");
  first.disk.delete("target/a.txt");
  first.emit({ removed: ["target", "target/a.txt"] });
  first.store.open("src/a.txt");
  await first.store.buffers.load("src/a.txt");
  first.disk.set("target/a.txt", "new");
  first.disk.delete("src/a.txt");
  first.emit({
    moves: [
      { from: "src", to: "target", operation: 1 },
      { from: "src/a.txt", to: "target/a.txt", operation: 1 },
    ],
  });
  await tick();
  const aside = first.store.tabs().find((tab) => isDetached(tab.path))?.path;
  expect(aside).toBeDefined();

  // Tab 1 hides and closes, leaving the detached draft in recovery.
  await first.store.pageHidden();
  first.dispose();

  // Another attached tab opens a different file and overwrites the saved tab list without the detached key.
  const attached = setUpStore({}, first.disk);
  attached.store.open("other.txt");
  attached.dispose();

  // Reopening discovers the detached draft from recovery and loads it without FileService rejecting the NUL key.
  const reopened = setUpStore({}, first.disk);
  await tick();
  await tick();
  expect(reopened.store.tabs().map((tab) => tab.path)).toContain(aside as string);
  const buffer = await reopened.store.buffers.load(aside as string);
  expect(buffer?.session.materializeFullText()).toBe("draft old");
  expect(buffer?.dirty()).toBe(true);
  expect(buffer?.missing()).toBe(true);

  // Saving attaches it to a free name and clears the recovery entry once durable.
  await reopened.store.save(aside);
  await tick();
  expect(first.disk.get("target/a (draft).txt")).toBe("draft old");
  expect(recoveryKeys()).toEqual([]);
  reopened.dispose();
});

test("an earlier flush finishing does not erase a draft detached after its file was deleted and replaced", async () => {
  const first = setUpStore({ "target/a.txt": "old", "src/a.txt": "replacement" });
  first.store.setAutosave(false);
  first.holdFlushes();
  first.store.open("target/a.txt");
  await first.store.buffers.load("target/a.txt");
  // Save an edit to target/a.txt and hold its flush.
  type(first.store, "target/a.txt", "saved-but-unflushed ");
  await first.store.save("target/a.txt");
  expect(first.flushes).toHaveLength(1);

  // Shell deletes target/a.txt and the editor syncs: the buffer becomes dirty and missing.
  first.disk.delete("target/a.txt");
  await first.store.buffers.sync();
  expect(first.store.buffers.get("target/a.txt")?.dirty()).toBe(true);
  expect(first.store.buffers.get("target/a.txt")?.missing()).toBe(true);

  // Move another open file into target/a.txt, detaching the original buffer, then hide the page.
  first.store.open("src/a.txt");
  await first.store.buffers.load("src/a.txt");
  first.disk.set("target/a.txt", "replacement");
  first.disk.delete("src/a.txt");
  first.emit({
    moves: [
      { from: "src", to: "target", operation: 1 },
      { from: "src/a.txt", to: "target/a.txt", operation: 1 },
    ],
  });
  await tick();
  const aside = first.store.tabs().find((tab) => isDetached(tab.path))?.path;
  expect(aside).toBeDefined();

  await first.store.pageHidden();
  expect(recoveryKeys()).toHaveLength(1);

  // Completing the old flush for target/a.txt must NOT delete the detached draft's recovery copy.
  first.flushes.shift()?.resolve();
  await tick();
  expect(recoveryKeys()).toHaveLength(1);
  first.dispose();

  // Reloading recovers the detached draft while the replacement file stays intact on disk.
  const reopened = setUpStore({}, first.disk);
  await tick();
  await tick();
  const buffer = await reopened.store.buffers.load(aside as string);
  expect(buffer?.session.materializeFullText()).toBe("saved-but-unflushed old");
  expect(first.disk.get("target/a.txt")).toBe("replacement");
  reopened.dispose();
});

test("a move reported before editor sync preserves a clean buffer's pending undurable write as a detached draft", async () => {
  const first = setUpStore({ "target/a.txt": "old", "src/a.txt": "replacement" });
  first.store.setAutosave(false);
  first.holdFlushes();
  first.store.open("target/a.txt");
  await first.store.buffers.load("target/a.txt");
  first.store.open("src/a.txt");
  await first.store.buffers.load("src/a.txt");

  // Edit and save target/a.txt, holding its flush so the buffer is clean in memory but undurable.
  type(first.store, "target/a.txt", "unflushed ");
  await first.store.save("target/a.txt");
  expect(first.store.buffers.get("target/a.txt")?.dirty()).toBe(false);
  expect(first.flushes).toHaveLength(1);

  // First page hide records the pending undurable write for recovery.
  await first.store.pageHidden();
  expect(recoveryKeys()).toHaveLength(1);

  // Delete target/a.txt and move src -> target BEFORE editor sync runs.
  first.disk.set("target/a.txt", "replacement");
  first.disk.delete("src/a.txt");
  first.emit({
    moves: [
      { from: "src", to: "target", operation: 1 },
      { from: "src/a.txt", to: "target/a.txt", operation: 1 },
    ],
  });
  await tick();
  const detachedTabs = first.store.tabs().filter((tab) => isDetached(tab.path));
  expect(detachedTabs).toHaveLength(1);
  const aside = detachedTabs[0]!.path;
  expect(first.store.buffers.get(aside)?.dirty()).toBe(true);

  // Reject the held flush and hide the page again: the detached draft's recovery copy must stay.
  first.flushes.shift()?.reject(new Error("flush failed"));
  await tick();
  await first.store.pageHidden();
  expect(recoveryKeys()).toHaveLength(1);
  first.dispose();

  // Reopening recovers the unflushed edit while keeping the replacement file on disk.
  const reopened = setUpStore({}, first.disk);
  await tick();
  await tick();
  expect(reopened.store.tabs().map((tab) => tab.path)).toContain(aside);
  const buffer = await reopened.store.buffers.load(aside);
  expect(buffer?.session.materializeFullText()).toBe("unflushed old");
  expect(first.disk.get("target/a.txt")).toBe("replacement");
  reopened.dispose();
});

test("closing and reopening a clean tab while its save flush is pending preserves the edit across replacement", async () => {
  const first = setUpStore({ "target/a.txt": "old", "src/a.txt": "replacement" });
  first.store.setAutosave(false);
  first.holdFlushes();
  first.store.open("target/a.txt");
  await first.store.buffers.load("target/a.txt");
  first.store.open("src/a.txt");
  await first.store.buffers.load("src/a.txt");

  // Save target/a.txt with its flush held, then close and reopen the clean tab.
  type(first.store, "target/a.txt", "unflushed ");
  await first.store.save("target/a.txt");
  first.store.close("target/a.txt");
  first.store.open("target/a.txt");
  const reopenedClean = await first.store.buffers.load("target/a.txt");
  expect(reopenedClean?.session.materializeFullText()).toBe("unflushed old");
  expect(reopenedClean?.dirty()).toBe(false);

  // First page hide records the pending undurable write for recovery.
  await first.store.pageHidden();
  expect(recoveryKeys()).toHaveLength(1);

  // Move src -> target before editor sync runs, then reject the held flush and hide again.
  first.disk.set("target/a.txt", "replacement");
  first.disk.delete("src/a.txt");
  first.emit({
    moves: [
      { from: "src", to: "target", operation: 1 },
      { from: "src/a.txt", to: "target/a.txt", operation: 1 },
    ],
  });
  await tick();
  const aside = first.store.tabs().find((tab) => isDetached(tab.path))?.path;
  expect(aside).toBeDefined();

  first.flushes.shift()?.reject(new Error("flush failed"));
  await tick();
  await first.store.pageHidden();
  expect(recoveryKeys()).toHaveLength(1);
  first.dispose();

  const recovered = setUpStore({}, first.disk);
  await tick();
  await tick();
  expect(recovered.store.tabs().map((tab) => tab.path)).toContain(aside as string);
  const buffer = await recovered.store.buffers.load(aside as string);
  expect(buffer?.session.materializeFullText()).toBe("unflushed old");
  expect(first.disk.get("target/a.txt")).toBe("replacement");
  recovered.dispose();
});

test("a move replacing a closed file with a pending undurable write converts it into a detached draft", async () => {
  const first = setUpStore({ "target/a.txt": "old", "src/a.txt": "replacement" });
  first.store.setAutosave(false);
  first.holdFlushes();
  first.store.open("target/a.txt");
  await first.store.buffers.load("target/a.txt");

  // Save target/a.txt with flush held, hide once, then close the clean tab without reopening it.
  type(first.store, "target/a.txt", "closed-unflushed ");
  await first.store.save("target/a.txt");
  await first.store.pageHidden();
  first.store.close("target/a.txt");
  expect(first.store.buffers.get("target/a.txt")).toBeUndefined();
  expect(recoveryKeys()).toHaveLength(1);

  // Another file (not even open in the editor) moves onto target/a.txt.
  first.disk.set("target/a.txt", "replacement");
  first.disk.delete("src/a.txt");
  first.emit({
    moves: [
      { from: "src", to: "target", operation: 1 },
      { from: "src/a.txt", to: "target/a.txt", operation: 1 },
    ],
  });
  await tick();
  const aside = first.store.tabs().find((tab) => isDetached(tab.path))?.path;
  expect(aside).toBeDefined();
  expect(first.store.buffers.get(aside as string)?.session.materializeFullText()).toBe(
    "closed-unflushed old",
  );

  // Rejecting the held flush and hiding again keeps the detached draft recoverable.
  first.flushes.shift()?.reject(new Error("flush failed"));
  await tick();
  await first.store.pageHidden();
  expect(recoveryKeys()).toHaveLength(1);
  first.dispose();

  const recovered = setUpStore({}, first.disk);
  await tick();
  await tick();
  const buffer = await recovered.store.buffers.load(aside as string);
  expect(buffer?.session.materializeFullText()).toBe("closed-unflushed old");
  expect(first.disk.get("target/a.txt")).toBe("replacement");
  recovered.dispose();
});

test("a move whose source is not open still detaches a displaced open buffer with a pending write", async () => {
  const first = setUpStore({ "target/a.txt": "old", "src/a.txt": "replacement" });
  first.store.setAutosave(false);
  first.holdFlushes();
  first.store.open("target/a.txt");
  await first.store.buffers.load("target/a.txt");

  type(first.store, "target/a.txt", "unflushed ");
  await first.store.save("target/a.txt");
  await first.store.pageHidden();

  // src/a.txt is NOT open; moving src -> target must still detach target/a.txt.
  first.disk.set("target/a.txt", "replacement");
  first.disk.delete("src/a.txt");
  first.emit({ moves: [{ from: "src", to: "target", operation: 1 }] });
  await tick();
  const aside = first.store.tabs().find((tab) => isDetached(tab.path))?.path;
  expect(aside).toBeDefined();

  first.flushes.shift()?.reject(new Error("flush failed"));
  await tick();
  await first.store.pageHidden();
  expect(recoveryKeys()).toHaveLength(1);
  first.dispose();

  const recovered = setUpStore({}, first.disk);
  await tick();
  await tick();
  const buffer = await recovered.store.buffers.load(aside as string);
  expect(buffer?.session.materializeFullText()).toBe("unflushed old");
  recovered.dispose();
});

test("a clean open file replaced by a move from an unopened file keeps its buffer and saves edits", async () => {
  const { store, disk, emit } = setUpStore({ "target/a.txt": "old", "src/a.txt": "replacement" });
  store.setAutosave(false);
  store.open("target/a.txt");
  const before = await store.buffers.load("target/a.txt");

  // Delete target/a.txt through FileService, then move the unopened src/a.txt onto it.
  disk.delete("target/a.txt");
  emit({ removed: ["target/a.txt"] });
  disk.set("target/a.txt", "replacement");
  disk.delete("src/a.txt");
  emit({ moves: [{ from: "src/a.txt", to: "target/a.txt", operation: 1 }] });
  await tick();
  await store.buffers.sync();

  // The editor still shows the same session: it stays registered and follows the new file.
  const after = store.buffers.get("target/a.txt");
  expect(after).toBe(before);
  expect(after?.session.materializeFullText()).toBe("replacement");
  expect(after?.dirty()).toBe(false);
  expect(store.tabs().filter((tab) => isDetached(tab.path))).toHaveLength(0);

  // Typing into the mounted session is saved and recorded on page hide.
  type(store, "target/a.txt", "typed ");
  await store.pageHidden();
  expect(recoveryKeys()).toHaveLength(1);
  await store.save("target/a.txt");
  expect(disk.get("target/a.txt")).toBe("typed replacement");
});

test("a reopened replacement never takes over an older pending write at its path", async () => {
  const first = setUpStore({ "target/a.txt": "old", "src/a.txt": "replacement" });
  first.store.setAutosave(false);
  first.holdFlushes();
  first.store.open("target/a.txt");
  await first.store.buffers.load("target/a.txt");

  // Save with the flush held, close the tab, replace the file through the shell and reopen it.
  type(first.store, "target/a.txt", "unflushed ");
  await first.store.save("target/a.txt");
  first.store.close("target/a.txt");
  first.disk.set("target/a.txt", "shell");
  first.store.open("target/a.txt");
  const replacement = await first.store.buffers.load("target/a.txt");
  expect(replacement?.session.materializeFullText()).toBe("shell");

  // Delete the replacement through the shell and let sync run; the old flush fails.
  first.disk.delete("target/a.txt");
  await first.store.buffers.sync();
  expect(replacement?.dirty()).toBe(false);
  first.flushes.shift()?.reject(new Error("flush failed"));
  await tick();

  // Move an unopened file into the vacated path.
  first.disk.set("target/a.txt", "replacement");
  first.disk.delete("src/a.txt");
  first.emit({ moves: [{ from: "src/a.txt", to: "target/a.txt", operation: 1 }] });
  await tick();
  await first.store.buffers.sync();

  // The original edit is set aside on its own tab; the open tab follows the new file.
  const aside = first.store.tabs().find((tab) => isDetached(tab.path))?.path;
  expect(aside).toBeDefined();
  expect(first.store.buffers.get(aside as string)?.session.materializeFullText()).toBe("unflushed old");
  expect(first.store.buffers.get("target/a.txt")).toBe(replacement);
  expect(replacement?.session.materializeFullText()).toBe("replacement");
  expect(replacement?.dirty()).toBe(false);

  await first.store.pageHidden();
  first.dispose();
  const recovered = setUpStore({}, first.disk);
  await tick();
  await tick();
  const buffer = await recovered.store.buffers.load(aside as string);
  expect(buffer?.session.materializeFullText()).toBe("unflushed old");
  expect(first.disk.get("target/a.txt")).toBe("replacement");
  recovered.dispose();
});

test("saving the older of two drafts split from one path keeps the newer draft's recovery copy", async () => {
  const first = setUpStore({ "target/a.txt": "old", "src/a.txt": "replacement" });
  first.store.setAutosave(false);
  first.holdFlushes();
  first.store.open("target/a.txt");
  await first.store.buffers.load("target/a.txt");

  // A save whose flush is held, then different shell text reopened at the path and edited.
  type(first.store, "target/a.txt", "unflushed ");
  await first.store.save("target/a.txt");
  first.store.close("target/a.txt");
  first.disk.set("target/a.txt", "shell");
  first.store.open("target/a.txt");
  await first.store.buffers.load("target/a.txt");
  type(first.store, "target/a.txt", "newer ");
  await first.store.pageHidden();

  // An unopened file moves onto the path: the pending write and the newer edits split apart.
  first.disk.set("target/a.txt", "replacement");
  first.disk.delete("src/a.txt");
  first.emit({ moves: [{ from: "src/a.txt", to: "target/a.txt", operation: 1 }] });
  await tick();
  const asides = first.store.tabs().filter((tab) => isDetached(tab.path));
  expect(asides).toHaveLength(2);
  const textOf = (path: string) => first.store.buffers.get(path)?.session.materializeFullText();
  const older = asides.find((tab) => textOf(tab.path) === "unflushed old")?.path;
  const newer = asides.find((tab) => textOf(tab.path) === "newer shell")?.path;
  expect(older).toBeDefined();
  expect(newer).toBeDefined();

  // Save only the older one, durably, then the page ends without another snapshot.
  first.releaseFlushes();
  await first.store.save(older as string);
  await tick();
  await tick();
  first.dispose();

  const recovered = setUpStore({}, first.disk);
  await tick();
  await tick();
  const buffer = await recovered.store.buffers.load(newer as string);
  expect(buffer?.session.materializeFullText()).toBe("newer shell");
  recovered.dispose();
});
