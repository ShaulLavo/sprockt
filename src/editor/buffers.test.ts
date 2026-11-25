import { expect, test } from "bun:test";
import { createBufferSet, type BufferSetOptions } from "./buffers";
import type { Draft } from "./recovery";

/**
 * An in-memory FileService. `writeIfUnchanged` behaves like the real one: it checks that the file
 * still holds the expected text, then writes, in two steps. With `gateWrites()` each write waits
 * between the two steps for its own gate, so a test can release writes in any order.
 */
function memoryFiles(initial: Record<string, string>) {
  const disk = new Map(Object.entries(initial));
  let gated = false;
  let failing = false;
  const gates: PromiseWithResolvers<void>[] = [];
  return {
    disk,
    gates,
    gateWrites() {
      gated = true;
    },
    failWrites() {
      failing = true;
    },
    flushes: [] as PromiseWithResolvers<void>[],
    /** By default every write is durable at once; `holdFlushes()` keeps them pending. */
    holdFlushes() {
      this.flushing = true;
    },
    flushing: false,
    saved(): Promise<void> {
      if (!this.flushing) return Promise.resolve();
      const flush = Promise.withResolvers<void>();
      this.flushes.push(flush);
      return flush.promise;
    },
    read: async (path: string) => disk.get(path),
    async writeIfUnchanged(path: string, content: string, expected: string | undefined) {
      const current = disk.get(path);
      if (current !== expected) return { written: false as const, current };
      if (failing) throw new Error("storage refused the write");
      if (gated) {
        const gate = Promise.withResolvers<void>();
        gates.push(gate);
        await gate.promise;
      }
      disk.set(path, content);
      return { written: true as const };
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function setUp(initial: Record<string, string>, options: BufferSetOptions = {}) {
  const files = memoryFiles(initial);
  return { files, buffers: createBufferSet(files, options) };
}

type Buffers = ReturnType<typeof createBufferSet>;

function type(buffers: Buffers, path: string, text: string): void {
  const session = buffers.get(path)?.session;
  if (!session) throw new Error(`${path} is not open`);
  const end = session.materializeFullText().length;
  session.applyEdits([{ from: end, to: end, text }]);
}

const textOf = (buffers: Buffers, path: string) => buffers.get(path)?.session.materializeFullText();

test("a file loads once, shares its buffer, and a missing file has none", async () => {
  const { buffers } = setUp({ "a.txt": "one" });
  const [first, second] = await Promise.all([buffers.load("a.txt"), buffers.load("a.txt")]);
  expect(first).toBe(second);
  expect(first?.session.materializeFullText()).toBe("one");
  expect(first?.dirty()).toBe(false);
  expect(await buffers.load("nope.txt")).toBeUndefined();
});

test("typing makes a buffer dirty and tells the editor once; a save writes only its own file", async () => {
  const edits: string[] = [];
  const { files, buffers } = setUp(
    { "a.txt": "one", "b.txt": "two" },
    { onEdit: (path) => edits.push(path) },
  );
  await buffers.load("a.txt");
  await buffers.load("b.txt");
  type(buffers, "a.txt", " more");
  type(buffers, "a.txt", "!");
  expect(buffers.dirtyPaths()).toEqual(["a.txt"]);
  expect(edits).toEqual(["a.txt"]);
  await buffers.save("a.txt");
  expect(files.disk.get("a.txt")).toBe("one more!");
  expect(files.disk.get("b.txt")).toBe("two");
  expect(buffers.get("a.txt")?.dirty()).toBe(false);
  expect(buffers.dirtyPaths()).toEqual([]);
});

test("unsaved edits stay with their file while another file is edited and saved", async () => {
  const { files, buffers } = setUp({ "a.txt": "A", "b.txt": "B" });
  await buffers.load("a.txt");
  type(buffers, "a.txt", " edited");
  await buffers.load("b.txt");
  type(buffers, "b.txt", " too");
  await buffers.save("b.txt");
  expect(files.disk.get("b.txt")).toBe("B too");
  expect(files.disk.get("a.txt")).toBe("A");
  expect(textOf(buffers, "a.txt")).toBe("A edited");
  expect(buffers.dirtyPaths()).toEqual(["a.txt"]);
});

test("a finished save clears dirty only for the edits it contained", async () => {
  const { files, buffers } = setUp({ "a.txt": "one" });
  await buffers.load("a.txt");
  type(buffers, "a.txt", "1");
  files.gateWrites();
  const saving = buffers.save("a.txt");
  type(buffers, "a.txt", "2");
  await tick();
  files.gates.shift()?.resolve();
  await saving;
  expect(files.disk.get("a.txt")).toBe("one1");
  expect(buffers.get("a.txt")?.dirty()).toBe(true);
  // The next save expects what the first one wrote.
  const second = buffers.save("a.txt");
  await tick();
  files.gates.shift()?.resolve();
  await second;
  expect(files.disk.get("a.txt")).toBe("one12");
  expect(buffers.get("a.txt")?.dirty()).toBe(false);
});

test("an undo made while a save is writing is still unsaved once the save lands", async () => {
  const { files, buffers } = setUp({ "a.txt": "one" });
  const buffer = await buffers.load("a.txt");
  type(buffers, "a.txt", " more");
  files.gateWrites();
  const saving = buffers.save("a.txt");
  buffer?.session.undo();
  expect(textOf(buffers, "a.txt")).toBe("one");
  // Closing now has to ask: the write in flight holds text the buffer no longer shows.
  expect(buffer?.dirty()).toBe(true);
  await tick();
  files.gates.shift()?.resolve();
  await saving;
  expect(files.disk.get("a.txt")).toBe("one more");
  expect(buffer?.dirty()).toBe(true);
  // Redoing back to the saved text is clean again.
  buffer?.session.redo();
  expect(buffer?.dirty()).toBe(false);
});

test("a buffer stays unsaved until its write succeeds, and a failed write leaves it unsaved", async () => {
  const { files, buffers } = setUp({ "a.txt": "one" });
  const buffer = await buffers.load("a.txt");
  type(buffers, "a.txt", " more");
  files.gateWrites();
  const saving = buffers.save("a.txt");
  // Closing now must still ask: nothing has reached the disk yet.
  expect(buffer?.dirty()).toBe(true);
  expect(Object.fromEntries(buffers.unsaved())).toEqual({ "a.txt": { text: "one more", baseText: "one" } });
  await tick();
  files.gates.shift()?.resolve();
  await saving;
  expect(buffer?.dirty()).toBe(false);

  type(buffers, "a.txt", "!");
  files.failWrites();
  await expect(buffers.save("a.txt")).rejects.toThrow("storage refused the write");
  expect(buffer?.dirty()).toBe(true);
  expect(files.disk.get("a.txt")).toBe("one more");
});

/** Lets writes through newest first, as slow storage might, for a few rounds. */
async function releaseNewestFirst(files: ReturnType<typeof memoryFiles>): Promise<void> {
  for (let round = 0; round < 6; round += 1) {
    for (const gate of files.gates.splice(0).toReversed()) gate.resolve();
    // oxlint-disable-next-line no-await-in-loop -- each round lets the next queued write start
    await tick();
  }
}

test("closing and reopening a file while its write is pending never lets the older write land last", async () => {
  const { files, buffers } = setUp({ "a.txt": "one" });
  await buffers.load("a.txt");
  type(buffers, "a.txt", "1");
  files.gateWrites();
  const older = buffers.save("a.txt").catch(() => {});
  await tick();
  buffers.release("a.txt");

  const reopening = buffers.load("a.txt");
  await tick();
  // Without a queue per path the reopened buffer is ready at once and races the parked write.
  const saves = [older];
  const typeAndSave = () => {
    const session = buffers.get("a.txt")?.session;
    session?.applyEdits([{ from: 0, to: 0, text: "X" }]);
    saves.push(buffers.save("a.txt").catch(() => {}));
  };
  const early = buffers.get("a.txt") !== undefined;
  if (early) typeAndSave();
  await releaseNewestFirst(files);
  await reopening;
  if (!early) typeAndSave();
  await releaseNewestFirst(files);
  await Promise.all(saves);

  const buffer = buffers.get("a.txt");
  // What the editor shows as saved is what the disk holds.
  if (!buffer?.dirty()) expect(files.disk.get("a.txt")).toBe(textOf(buffers, "a.txt"));
  expect(buffer?.dirty() === false || buffer?.conflict() !== undefined).toBe(true);
});

test("overlapping saves of one file run in order, so an older write never lands last", async () => {
  const { files, buffers } = setUp({ "a.txt": "one" });
  await buffers.load("a.txt");
  type(buffers, "a.txt", "1");
  files.gateWrites();
  const older = buffers.save("a.txt");
  type(buffers, "a.txt", "2");
  const newer = buffers.save("a.txt");
  // Release the latest waiting write first, as slow storage might finish them. Two writes need
  // at most two rounds; a few more cost nothing.
  for (let round = 0; round < 4; round += 1) {
    for (const gate of files.gates.splice(0).toReversed()) gate.resolve();
    // oxlint-disable-next-line no-await-in-loop -- each round lets the next queued write start
    await tick();
  }
  await Promise.all([older, newer]);
  expect(files.disk.get("a.txt")).toBe("one12");
  expect(textOf(buffers, "a.txt")).toBe("one12");
  expect(buffers.get("a.txt")?.dirty()).toBe(false);
  expect(buffers.get("a.txt")?.conflict()).toBeUndefined();
});

test("a save does not overwrite a change made on disk since the file was read", async () => {
  const { files, buffers } = setUp({ "a.txt": "A" });
  await buffers.load("a.txt");
  type(buffers, "a.txt", " mine");
  files.disk.set("a.txt", "A from the shell");
  await buffers.save("a.txt");
  expect(files.disk.get("a.txt")).toBe("A from the shell");
  expect(buffers.get("a.txt")?.conflict()).toEqual({ diskText: "A from the shell" });
  expect(buffers.get("a.txt")?.dirty()).toBe(true);
});

test("a clean buffer follows the disk without becoming dirty or pinning anything", async () => {
  const edits: string[] = [];
  const { files, buffers } = setUp(
    { "a.txt": "line one\nline two\n" },
    { onEdit: (path) => edits.push(path) },
  );
  await buffers.load("a.txt");
  files.disk.set("a.txt", "line one\nchanged\n");
  await buffers.sync();
  expect(textOf(buffers, "a.txt")).toBe("line one\nchanged\n");
  expect(buffers.get("a.txt")?.dirty()).toBe(false);
  expect(buffers.get("a.txt")?.conflict()).toBeUndefined();
  expect(edits).toEqual([]);
});

test("a conflict goes away when the disk returns to the text the buffer was based on", async () => {
  const { files, buffers } = setUp({ "a.txt": "base" });
  await buffers.load("a.txt");
  type(buffers, "a.txt", " mine");
  files.disk.set("a.txt", "transient");
  await buffers.sync();
  expect(buffers.get("a.txt")?.conflict()).toEqual({ diskText: "transient" });
  files.disk.set("a.txt", "base");
  await buffers.sync();
  expect(buffers.get("a.txt")?.conflict()).toBeUndefined();
  expect(textOf(buffers, "a.txt")).toBe("base mine");
  expect(buffers.get("a.txt")?.dirty()).toBe(true);
});

test("reload from disk takes what the file holds now, not the version the conflict was raised for", async () => {
  const { files, buffers } = setUp({ "a.txt": "base" });
  await buffers.load("a.txt");
  type(buffers, "a.txt", " mine");
  files.disk.set("a.txt", "first outside");
  await buffers.sync();
  files.disk.set("a.txt", "second outside");
  await buffers.takeTheirs("a.txt");
  expect(textOf(buffers, "a.txt")).toBe("second outside");
  expect(buffers.get("a.txt")?.dirty()).toBe(false);
});

test("reload from disk on a file deleted since the conflict keeps the draft, marked deleted", async () => {
  const { files, buffers } = setUp({ "a.txt": "base" });
  await buffers.load("a.txt");
  type(buffers, "a.txt", " mine");
  files.disk.set("a.txt", "outside");
  await buffers.sync();
  files.disk.delete("a.txt");
  await buffers.takeTheirs("a.txt");
  const buffer = buffers.get("a.txt");
  expect(textOf(buffers, "a.txt")).toBe("base mine");
  expect(buffer?.dirty()).toBe(true);
  expect(buffer?.missing()).toBe(true);
  expect(buffer?.conflict()).toBeUndefined();
});

test("deleting a file under unsaved edits keeps the edits and drops the stale conflict", async () => {
  const { files, buffers } = setUp({ "a.txt": "base" });
  await buffers.load("a.txt");
  type(buffers, "a.txt", " mine");
  files.disk.set("a.txt", "outside");
  await buffers.sync();
  files.disk.delete("a.txt");
  await buffers.sync();
  const buffer = buffers.get("a.txt");
  expect(buffer?.missing()).toBe(true);
  expect(buffer?.conflict()).toBeUndefined();
  expect(textOf(buffers, "a.txt")).toBe("base mine");
  await buffers.save("a.txt");
  expect(files.disk.get("a.txt")).toBe("base mine");
});

test("a dirty buffer keeps its text and gets a conflict; take-theirs reloads, keep-mine wins the next save", async () => {
  const { files, buffers } = setUp({ "a.txt": "base" });
  const buffer = await buffers.load("a.txt");
  type(buffers, "a.txt", " mine");
  files.disk.set("a.txt", "theirs");
  await buffers.sync();
  expect(buffer?.session.materializeFullText()).toBe("base mine");
  expect(buffer?.conflict()).toEqual({ diskText: "theirs" });

  await buffers.takeTheirs("a.txt");
  expect(buffer?.session.materializeFullText()).toBe("theirs");
  expect(buffer?.dirty()).toBe(false);
  expect(buffer?.conflict()).toBeUndefined();

  type(buffers, "a.txt", " again");
  files.disk.set("a.txt", "theirs 2");
  await buffers.sync();
  await buffers.keepMine("a.txt");
  expect(buffer?.conflict()).toBeUndefined();
  // The disk does not change again, so no new conflict appears for the same outside version.
  await buffers.sync();
  expect(buffer?.conflict()).toBeUndefined();
  await buffers.save("a.txt");
  expect(files.disk.get("a.txt")).toBe("theirs again");
});

test("a buffer whose text matches the new disk text simply becomes clean", async () => {
  const { files, buffers } = setUp({ "a.txt": "a" });
  await buffers.load("a.txt");
  type(buffers, "a.txt", "b");
  files.disk.set("a.txt", "ab");
  await buffers.sync();
  expect(buffers.get("a.txt")?.dirty()).toBe(false);
  expect(buffers.get("a.txt")?.conflict()).toBeUndefined();
});

test("a deleted file is flagged missing and a save writes it back", async () => {
  const { files, buffers } = setUp({ "a.txt": "keep" });
  await buffers.load("a.txt");
  files.disk.delete("a.txt");
  await buffers.sync();
  expect(buffers.get("a.txt")?.missing()).toBe(true);
  await buffers.save("a.txt");
  expect(files.disk.get("a.txt")).toBe("keep");
  expect(buffers.get("a.txt")?.missing()).toBe(false);
});

test("text another tab left behind opens as unsaved, against the disk text it was made from", async () => {
  const drafts: Record<string, Draft> = { "a.txt": { text: "left behind", baseText: "A" } };
  const recover = (path: string) => drafts[path];
  const { files, buffers } = setUp({ "a.txt": "A" }, { recover });
  await buffers.load("a.txt");
  expect(textOf(buffers, "a.txt")).toBe("left behind");
  expect(buffers.get("a.txt")?.dirty()).toBe(true);
  expect(buffers.get("a.txt")?.conflict()).toBeUndefined();
  await buffers.save("a.txt");
  expect(files.disk.get("a.txt")).toBe("left behind");
});

test("recovered text whose file changed since is a conflict, not a silent overwrite", async () => {
  const drafts: Record<string, Draft> = { "a.txt": { text: "left behind", baseText: "old" } };
  const { buffers } = setUp({ "a.txt": "new" }, { recover: (path) => drafts[path] });
  await buffers.load("a.txt");
  expect(buffers.get("a.txt")?.conflict()).toEqual({ diskText: "new" });
});

test("unsaved() lists every buffer with unsaved edits and the disk text it was made from", async () => {
  const { buffers } = setUp({ "a.txt": "A", "b.txt": "B", "c.txt": "C" });
  await Promise.all(["a.txt", "b.txt", "c.txt"].map((path) => buffers.load(path)));
  type(buffers, "a.txt", " edited");
  type(buffers, "b.txt", " edited");
  expect(Object.fromEntries(buffers.unsaved())).toEqual({
    "a.txt": { text: "A edited", baseText: "A" },
    "b.txt": { text: "B edited", baseText: "B" },
  });
});

test("a rename moves buffers, including those under a moved directory", async () => {
  const { buffers } = setUp({ "src/a.ts": "a" });
  const buffer = await buffers.load("src/a.ts");
  buffers.rename("src", "lib");
  expect(buffers.get("lib/a.ts")).toBe(buffer);
  expect(buffers.get("src/a.ts")).toBeUndefined();
  expect(buffer?.path).toBe("lib/a.ts");
});

test("a write acknowledged from memory stays recoverable until storage holds it", async () => {
  const durable: string[] = [];
  const { files, buffers } = setUp({ "a.txt": "A" }, { onDurable: (path) => durable.push(path) });
  files.holdFlushes();
  await buffers.load("a.txt");
  type(buffers, "a.txt", " saved");
  await buffers.save("a.txt");
  // Not dirty any more, but the flush has not finished: losing storage now would lose it.
  expect(buffers.get("a.txt")?.dirty()).toBe(false);
  expect(Object.fromEntries(buffers.unsaved())).toEqual({ "a.txt": { text: "A saved", baseText: "A" } });
  expect(durable).toEqual([]);
  files.flushes.shift()?.resolve();
  await tick();
  expect(buffers.unsaved().size).toBe(0);
  expect(durable).toEqual(["a.txt"]);
});

test("an undurable write is still recoverable after its tab closed", async () => {
  const { files, buffers } = setUp({ "a.txt": "A" });
  files.holdFlushes();
  await buffers.load("a.txt");
  type(buffers, "a.txt", " saved");
  await buffers.save("a.txt");
  buffers.release("a.txt");
  expect(Object.fromEntries(buffers.unsaved())).toEqual({ "a.txt": { text: "A saved", baseText: "A" } });
  files.flushes.shift()?.resolve();
  await tick();
  expect(buffers.unsaved().size).toBe(0);
});

test("text recovered from another tab stays recoverable until it is saved for good", async () => {
  const drafts: Record<string, Draft> = { "a.txt": { text: "left behind", baseText: "A" } };
  const { buffers } = setUp({ "a.txt": "A" }, { recover: (path) => drafts[path] });
  await buffers.load("a.txt");
  expect(Object.fromEntries(buffers.unsaved())).toEqual({ "a.txt": { text: "left behind", baseText: "A" } });
});

test("unsaved() works for any file name", async () => {
  const { buffers } = setUp({ constructor: "C" });
  await buffers.load("constructor");
  type(buffers, "constructor", " edited");
  expect(Array.from(buffers.unsaved())).toEqual([["constructor", { text: "C edited", baseText: "C" }]]);
});
