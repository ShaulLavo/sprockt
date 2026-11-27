import { describe, expect, test } from "bun:test";
import type { DirectoryLoadState } from "@shaulavo/workbench/core";
import type { EditorStore } from "../editor/store";
import { DestinationExistsError } from "../files/errors";
import type { DirEntry, FileChange, FileService } from "../files/service";
import { createSignal } from "../lib/reactive";
import { createWaffleFileSystemAdapter } from "./waffle-adapter";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeHarness(overrides?: {
  readdir?: (dir: string) => Promise<DirEntry[] | undefined>;
  exists?: (path: string) => Promise<boolean>;
  move?: (from: string, to: string) => Promise<void>;
  remove?: (path: string) => Promise<void>;
  openTabs?: readonly { readonly path: string; readonly unsaved?: boolean }[];
}) {
  const [writable] = createSignal(true);
  const [revision] = createSignal(0);
  const [saveState] = createSignal<"saved" | "saving" | "failed">("saved");
  const listeners = new Set<(change: FileChange) => void>();
  const tabs = new Map<string, boolean>((overrides?.openTabs ?? []).map((t) => [t.path, Boolean(t.unsaved)]));
  const closedTabs: string[] = [];
  const moveCalls: { from: string; to: string }[] = [];
  const removeCalls: string[] = [];

  const files: FileService = {
    list: async () => [],
    readdir: overrides?.readdir ?? (async () => []),
    read: async () => undefined,
    readBytes: async () => undefined,
    size: async () => undefined,
    exists: overrides?.exists ?? (async () => false),
    write: async () => {},
    writeIfUnchanged: async () => ({ written: true }),
    writeMany: async () => {},
    mkdir: async () => {},
    remove: async (path) => {
      removeCalls.push(path);
      if (overrides?.remove) await overrides.remove(path);
    },
    create: async () => {},
    move: async (from, to) => {
      moveCalls.push({ from, to });
      if (overrides?.move) await overrides.move(from, to);
    },
    upload: async () => ({ written: [], skipped: 0 }),
    exportZip: async () => new Blob(),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    subscribeEdits: () => () => {},
    revision,
    saveState,
    saved: async () => {},
    writable,
    dispose() {},
  };

  const store = {
    tabs: () => Array.from(tabs.keys(), (path) => ({ path })),
    hasUnsaved: (path: string) => tabs.get(path) === true,
    close: (path: string) => {
      closedTabs.push(path);
      tabs.delete(path);
    },
    open: () => {},
    lockPaths: async () => ({ release: () => {} }),
  } as unknown as EditorStore;

  const emitChange = (change: Partial<FileChange>) => {
    const full: FileChange = {
      paths: change.paths ?? [],
      reset: change.reset ?? false,
      moves: change.moves ?? [],
      removed: change.removed ?? [],
    };
    for (const listener of listeners) listener(full);
  };

  return { files, store, emitChange, closedTabs, moveCalls, removeCalls };
}

describe("createWaffleFileSystemAdapter", () => {
  test("ignores stale directory reads that resolve after a newer read, seed, or reset", async () => {
    const first = deferred<DirEntry[]>();
    const second = deferred<DirEntry[]>();
    let call = 0;
    const listed: { dir: string; names: string[] }[] = [];

    const harness = makeHarness({
      readdir: async () => {
        call += 1;
        return call === 1 ? first.promise : second.promise;
      },
    });

    const handle = createWaffleFileSystemAdapter({
      workspaceId: "ws-gen",
      files: harness.files,
      store: harness.store,
      onDirectoryListed(dir, entries) {
        listed.push({ dir, names: entries.map((e) => e.name) });
      },
    });

    const p1 = handle.refreshDirectory("src");
    const p2 = handle.refreshDirectory("src");

    second.resolve([{ name: "fresh.ts", kind: "file" }]);
    await p2;
    first.resolve([{ name: "stale.ts", kind: "file" }]);
    await p1;

    const state = handle.adapter.lazy!.getDirectoryState("src").getSnapshot() as Extract<
      DirectoryLoadState,
      { status: "loaded" }
    >;
    expect(state.status).toBe("loaded");
    expect(state.entries.map((e) => e.name)).toEqual(["fresh.ts"]);
    expect(listed).toEqual([{ dir: "src", names: ["fresh.ts"] }]);

    // Seeding invalidates an in-flight read so a late failure or result cannot overwrite seeded entries.
    const third = deferred<DirEntry[]>();
    const seedHarness = makeHarness({ readdir: async () => third.promise });
    const seedHandle = createWaffleFileSystemAdapter({
      workspaceId: "ws-seed",
      files: seedHarness.files,
      store: seedHarness.store,
    });
    const p3 = seedHandle.refreshDirectory("lib");
    seedHandle.seedDirectory("lib", [{ name: "seeded.ts", kind: "file" }]);
    third.reject(new Error("late failure"));
    await p3;

    const seededState = seedHandle.adapter.lazy!.getDirectoryState("lib").getSnapshot() as Extract<
      DirectoryLoadState,
      { status: "loaded" }
    >;
    expect(seededState.status).toBe("loaded");
    expect(seededState.entries.map((e) => e.name)).toEqual(["seeded.ts"]);

    // Reset invalidation rejects an in-flight read so stale entries cannot land after a reset.
    const fourth = deferred<DirEntry[]>();
    const resetHarness = makeHarness({ readdir: async () => fourth.promise });
    const resetHandle = createWaffleFileSystemAdapter({
      workspaceId: "ws-reset",
      files: resetHarness.files,
      store: resetHarness.store,
    });
    const p4 = resetHandle.refreshDirectory("app");
    resetHarness.emitChange({ reset: true });
    fourth.resolve([{ name: "stale-before-reset.ts", kind: "file" }]);
    await p4;
    expect(resetHandle.adapter.lazy!.getDirectoryState("app").getSnapshot().status).toBe("idle");

    // Ordinary file-change invalidation also invalidates an in-flight read of that directory.
    const fifth = deferred<DirEntry[]>();
    const changeHarness = makeHarness({ readdir: async () => fifth.promise });
    const changeHandle = createWaffleFileSystemAdapter({
      workspaceId: "ws-change",
      files: changeHarness.files,
      store: changeHarness.store,
    });
    const p5 = changeHandle.refreshDirectory("pkg");
    changeHarness.emitChange({ paths: ["pkg/added.ts"] });
    fifth.resolve([{ name: "stale-before-change.ts", kind: "file" }]);
    await p5;
    expect(changeHandle.adapter.lazy!.getDirectoryState("pkg").getSnapshot().status).toBe("idle");

    handle.dispose();
    seedHandle.dispose();
    resetHandle.dispose();
    changeHandle.dispose();
  });

  test("keeps clean tabs open when FileService.remove rejects, and closes only clean tabs after success", async () => {
    const failingHarness = makeHarness({
      openTabs: [
        { path: "clean.ts", unsaved: false },
        { path: "dirty.ts", unsaved: true },
      ],
      remove: async (path) => {
        if (path === "clean.ts") throw new Error("remove failed");
      },
    });
    const failingHandle = createWaffleFileSystemAdapter({
      workspaceId: "ws-rm-fail",
      files: failingHarness.files,
      store: failingHarness.store,
    });

    await expect(failingHandle.removePaths(["clean.ts"])).rejects.toThrow("remove failed");
    expect(failingHarness.closedTabs).toEqual([]);
    failingHandle.dispose();

    const okHarness = makeHarness({
      openTabs: [
        { path: "dir/clean.ts", unsaved: false },
        { path: "dir/dirty.ts", unsaved: true },
      ],
    });
    const okHandle = createWaffleFileSystemAdapter({
      workspaceId: "ws-rm-ok",
      files: okHarness.files,
      store: okHarness.store,
    });

    await okHandle.removePaths(["dir"]);
    expect(okHarness.closedTabs).toEqual(["dir/clean.ts"]);
    okHandle.dispose();
  });

  test("movePaths preflights existing destinations (including non-readdir entries like sockets) and duplicate names before moving the first item", async () => {
    const harness = makeHarness({
      // readdir intentionally omits Unix sockets while exists() uses the same lookup as FileService.move.
      readdir: async () => [],
      exists: async (path) => path === "dest/b.txt",
    });
    const handle = createWaffleFileSystemAdapter({
      workspaceId: "ws-move",
      files: harness.files,
      store: harness.store,
    });

    await expect(
      handle.movePaths([
        { from: "a.txt", to: "dest/a.txt" },
        { from: "b.txt", to: "dest/b.txt" },
      ]),
    ).rejects.toBeInstanceOf(DestinationExistsError);
    expect(harness.moveCalls).toEqual([]);

    await expect(
      handle.movePaths([
        { from: "one/same.txt", to: "dest/same.txt" },
        { from: "two/same.txt", to: "dest/same.txt" },
      ]),
    ).rejects.toBeInstanceOf(DestinationExistsError);
    expect(harness.moveCalls).toEqual([]);

    handle.dispose();
  });
});
