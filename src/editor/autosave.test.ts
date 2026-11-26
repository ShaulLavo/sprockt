import { expect, test } from "bun:test";
import {
  AUTOSAVE_SETTING_KEY,
  createAutosave,
  loadAutosaveSetting,
  storeAutosaveSetting,
  type AutosaveTimers,
} from "./autosave";
import { createBufferSet, isDetached } from "./buffers";

/** An in-memory FileService whose writes check the expected text first, as the real one does. */
function memoryFiles(initial: Record<string, string>) {
  const disk = new Map(Object.entries(initial));
  const writes: string[] = [];
  /** While set, every write waits on it after it was counted, as a slow storage would. */
  const hold: { gate: Promise<void> | undefined } = { gate: undefined };
  return {
    disk,
    writes,
    hold,
    saved: () => Promise.resolve(),
    read: async (path: string) => disk.get(path),
    async writeIfUnchanged(path: string, content: string, expected: string | undefined) {
      const current = disk.get(path);
      if (current !== expected) return { written: false as const, current };
      writes.push(path);
      if (hold.gate) await hold.gate;
      disk.set(path, content);
      return { written: true as const };
    },
  };
}

/** Timers a test advances by hand. */
function manualTimers() {
  let now = 0;
  const pending = new Map<number, { at: number; run: () => void }>();
  let next = 0;
  const timers: AutosaveTimers = {
    set(run, delay) {
      next += 1;
      pending.set(next, { at: now + delay, run });
      return next;
    },
    clear: (handle) => pending.delete(handle as number),
  };
  return {
    timers,
    count: () => pending.size,
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of pending) {
        if (timer.at > now) continue;
        pending.delete(id);
        timer.run();
      }
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function setUp(initial: Record<string, string>, settings: { enabled?: boolean; writable?: boolean } = {}) {
  const files = memoryFiles(initial);
  const clock = manualTimers();
  const state = { enabled: settings.enabled ?? true, writable: settings.writable ?? true };
  // The store wires it the same way: every edit restarts the wait.
  const autosave = createAutosave({
    buffers: {
      paths: () => buffers.paths(),
      get: (path) => buffers.get(path),
      save: (path, options) => buffers.save(path, options),
    },
    enabled: () => state.enabled,
    writable: () => state.writable,
    isDetached,
    timers: clock.timers,
  });
  const buffers = createBufferSet(files, { onChange: () => autosave.edited() });
  return { files, clock, state, autosave, buffers };
}

type Buffers = ReturnType<typeof createBufferSet>;

function type(buffers: Buffers, path: string, text: string): void {
  const session = buffers.get(path)?.session;
  if (!session) throw new Error(`${path} is not open`);
  const end = session.materializeFullText().length;
  session.applyEdits([{ from: end, to: end, text }]);
}

test("an edit is saved once a second has passed since the last keystroke", async () => {
  const { files, clock, buffers } = setUp({ "a.txt": "one" });
  await buffers.load("a.txt");
  type(buffers, "a.txt", " t");
  clock.advance(600);
  type(buffers, "a.txt", "wo");
  // The second keystroke started the wait again.
  clock.advance(600);
  await settle();
  expect(files.disk.get("a.txt")).toBe("one");
  expect(buffers.get("a.txt")?.dirty()).toBe(true);
  clock.advance(400);
  await settle();
  expect(files.disk.get("a.txt")).toBe("one two");
  expect(files.writes).toEqual(["a.txt"]);
  expect(buffers.get("a.txt")?.dirty()).toBe(false);
});

test("a flush saves every unsaved buffer at once and cancels the pending wait", async () => {
  const { files, clock, autosave, buffers } = setUp({ "a.txt": "A", "b.txt": "B", "c.txt": "C" });
  await buffers.load("a.txt");
  await buffers.load("b.txt");
  await buffers.load("c.txt");
  type(buffers, "a.txt", "1");
  type(buffers, "b.txt", "2");
  expect(clock.count()).toBe(1);
  await autosave.flush();
  expect(files.disk.get("a.txt")).toBe("A1");
  expect(files.disk.get("b.txt")).toBe("B2");
  // A clean buffer is not written.
  expect(files.writes.toSorted()).toEqual(["a.txt", "b.txt"]);
  expect(clock.count()).toBe(0);
});

test("reloading a clean buffer from disk is not an edit and starts no save", async () => {
  const { files, clock, buffers } = setUp({ "a.txt": "A" });
  await buffers.load("a.txt");
  files.disk.set("a.txt", "A from the shell");
  await buffers.sync();
  expect(buffers.get("a.txt")?.session.materializeFullText()).toBe("A from the shell");
  expect(clock.count()).toBe(0);
  expect(files.writes).toEqual([]);
});

test("a conflict is never resolved by autosave: the disk keeps the other change", async () => {
  const { files, clock, autosave, buffers } = setUp({ "a.txt": "A" });
  await buffers.load("a.txt");
  type(buffers, "a.txt", " mine");
  // The shell writes the file before the idle wait is over.
  files.disk.set("a.txt", "A from the shell");
  await buffers.sync();
  expect(buffers.get("a.txt")?.conflict()).toEqual({ diskText: "A from the shell" });
  clock.advance(1000);
  await settle();
  await autosave.flush();
  type(buffers, "a.txt", " more");
  clock.advance(1000);
  await settle();
  expect(files.writes).toEqual([]);
  expect(files.disk.get("a.txt")).toBe("A from the shell");
  expect(buffers.get("a.txt")?.conflict()).toEqual({ diskText: "A from the shell" });
  expect(buffers.get("a.txt")?.session.materializeFullText()).toBe("A mine more");
  expect(buffers.get("a.txt")?.dirty()).toBe(true);
});

test("a change on disk that autosave's own write runs into becomes a conflict, not an overwrite", async () => {
  const { files, clock, buffers } = setUp({ "a.txt": "A" });
  await buffers.load("a.txt");
  type(buffers, "a.txt", " mine");
  // No change event has arrived yet: the save itself finds the disk moved.
  files.disk.set("a.txt", "A from another tab");
  clock.advance(1000);
  await settle();
  expect(files.disk.get("a.txt")).toBe("A from another tab");
  expect(buffers.get("a.txt")?.conflict()).toEqual({ diskText: "A from another tab" });
  // Further typing does not retry over it.
  type(buffers, "a.txt", "!");
  clock.advance(1000);
  await settle();
  expect(files.writes).toEqual([]);
  expect(files.disk.get("a.txt")).toBe("A from another tab");
});

test("a file deleted under unsaved edits is not written again by autosave", async () => {
  const { files, autosave, buffers } = setUp({ "a.txt": "A" });
  await buffers.load("a.txt");
  type(buffers, "a.txt", " kept");
  files.disk.delete("a.txt");
  await buffers.sync();
  expect(buffers.get("a.txt")?.missing()).toBe(true);
  await autosave.flush();
  expect(files.disk.has("a.txt")).toBe(false);
  expect(buffers.get("a.txt")?.session.materializeFullText()).toBe("A kept");
});

test("a draft moved aside is not given a file by autosave", async () => {
  const { files, autosave, buffers } = setUp({ "a.txt": "A", "b.txt": "B" });
  await buffers.load("a.txt");
  await buffers.load("b.txt");
  type(buffers, "b.txt", " draft");
  // a.txt moves onto b.txt: the draft goes to a detached key.
  files.disk.set("b.txt", "A");
  files.disk.delete("a.txt");
  const [aside] = buffers.rename("a.txt", "b.txt");
  expect(aside && isDetached(aside.to)).toBe(true);
  await autosave.flush();
  expect(files.writes).toEqual([]);
  expect(aside && buffers.get(aside.to)?.dirty()).toBe(true);
});

test("with autosave off, or after another tab took the workspace, nothing is written", async () => {
  const off = setUp({ "a.txt": "A" }, { enabled: false });
  await off.buffers.load("a.txt");
  type(off.buffers, "a.txt", "1");
  expect(off.clock.count()).toBe(0);
  await off.autosave.flush();
  expect(off.files.writes).toEqual([]);

  const lost = setUp({ "a.txt": "A" });
  await lost.buffers.load("a.txt");
  type(lost.buffers, "a.txt", "1");
  lost.state.writable = false;
  lost.clock.advance(1000);
  await settle();
  expect(lost.files.writes).toEqual([]);
  expect(lost.buffers.get("a.txt")?.dirty()).toBe(true);
});

test("turning autosave off cancels a save that was waiting", async () => {
  const { files, clock, state, buffers } = setUp({ "a.txt": "A" });
  await buffers.load("a.txt");
  type(buffers, "a.txt", "1");
  state.enabled = false;
  clock.advance(1000);
  await settle();
  expect(files.writes).toEqual([]);
});

test("edits made while autosave writes stay unsaved and are saved after the next pause", async () => {
  const { files, clock, buffers } = setUp({ "a.txt": "A" });
  await buffers.load("a.txt");
  type(buffers, "a.txt", "1");
  clock.advance(1000);
  // The write is running; the person keeps typing.
  type(buffers, "a.txt", "2");
  await settle();
  expect(files.disk.get("a.txt")).toBe("A1");
  expect(buffers.get("a.txt")?.dirty()).toBe(true);
  clock.advance(1000);
  await settle();
  expect(files.disk.get("a.txt")).toBe("A12");
  expect(buffers.get("a.txt")?.dirty()).toBe(false);
});

test("a file deleted while its autosave waited for a move lock is not written again", async () => {
  const { files, autosave, buffers } = setUp({ "docs/a.txt": "A" });
  await buffers.load("docs/a.txt");
  type(buffers, "docs/a.txt", " edited");
  // A folder operation holds the path; the autosave is asked for while it waits.
  const lock = await buffers.lock(["docs"]);
  const saving = autosave.flush();
  // The operation deleted the folder.
  files.disk.delete("docs/a.txt");
  buffers.markRemoved(["docs"]);
  lock.release();
  await saving;
  expect(files.writes).toEqual([]);
  expect(files.disk.has("docs/a.txt")).toBe(false);
  expect(buffers.get("docs/a.txt")?.session.materializeFullText()).toBe("A edited");
});

test("many autosave requests while one write is held open write the edit once", async () => {
  const { files, autosave, buffers } = setUp({ "a.txt": "A" });
  await buffers.load("a.txt");
  type(buffers, "a.txt", "1");
  const gate = Promise.withResolvers<void>();
  files.hold.gate = gate.promise;
  // The first write starts; the edit is then still "unsaved" to anyone asking before it lands.
  const first = autosave.flush();
  const more = Array.from({ length: 8 }, () => autosave.flush());
  gate.resolve();
  await Promise.all(more.concat([first]));
  expect(files.writes).toEqual(["a.txt"]);
  expect(files.disk.get("a.txt")).toBe("A1");

  // An edit made during a held write is written once more after it, not once per request.
  const second = Promise.withResolvers<void>();
  files.hold.gate = second.promise;
  type(buffers, "a.txt", "2");
  const writing = autosave.flush();
  type(buffers, "a.txt", "3");
  const requests = Array.from({ length: 8 }, () => autosave.flush());
  second.resolve();
  files.hold.gate = undefined;
  await Promise.all(requests.concat([writing]));
  expect(files.writes).toEqual(["a.txt", "a.txt", "a.txt"]);
  expect(files.disk.get("a.txt")).toBe("A123");
  expect(buffers.get("a.txt")?.dirty()).toBe(false);
});

test("a disposed autosave saves nothing", async () => {
  const { files, clock, autosave, buffers } = setUp({ "a.txt": "A" });
  await buffers.load("a.txt");
  type(buffers, "a.txt", "1");
  autosave.dispose();
  clock.advance(1000);
  await autosave.flush();
  expect(files.writes).toEqual([]);
});

test("the setting defaults to on, remembers off, and survives blocked storage", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
  expect(loadAutosaveSetting(storage)).toBe(true);
  storeAutosaveSetting(storage, false);
  expect(values.get(AUTOSAVE_SETTING_KEY)).toBe("off");
  expect(loadAutosaveSetting(storage)).toBe(false);
  storeAutosaveSetting(storage, true);
  expect(loadAutosaveSetting(storage)).toBe(true);

  const blocked = {
    getItem: (): string | null => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => {
      throw new Error("blocked");
    },
  };
  expect(loadAutosaveSetting(blocked)).toBe(true);
  expect(() => storeAutosaveSetting(blocked, false)).not.toThrow();
});
