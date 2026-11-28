import { describe, expect, test } from "bun:test";
import { parseRoute } from "../routing/routes";
import { createProjectFiles, type ProjectFilesystem, type ResolvedEntry } from "../files/project-files";
import { PROJECT_ROOT, storageName } from "../workspace/paths";
import { readIncomplete, retryPath, type OpenIdle } from "./incomplete";
import {
  INCOMPLETE,
  parseMeta,
  serializeMeta,
  WORKSPACE_META_PATH,
  type WorkspaceMeta,
} from "../workspace/metadata";
import {
  createWorkspaceWithFiles,
  NotIncompleteError,
  RetrySourceMismatchError,
  WorkspaceBusyError,
  WorkspaceIdTakenError,
  WorkspaceMissingError,
  type NewWorkspaceDeps,
  type WorkspaceWriter,
} from "./new-workspace";

const META: WorkspaceMeta = {
  name: "demo",
  created: "2026-11-25T00:00:00.000Z",
  source: { kind: "github", owner: "acme", repo: "demo", ref: "feature/x", subdir: "apps/web" },
};

interface StoreEntry {
  readonly files: Map<string, string>;
  readonly dirs: Set<string>;
  locked: boolean;
}

function noop(): void {}

const encode = (meta: WorkspaceMeta) => new TextEncoder().encode(serializeMeta(meta));

const metaState = (files: Map<string, string>) =>
  parseMeta(files.get(WORKSPACE_META_PATH))?.state ?? "complete";

function dirsForFiles(files: Iterable<string>): Set<string> {
  const dirs = new Set<string>();
  for (const path of files) {
    if (path.startsWith("/")) continue;
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join("/"));
    }
  }
  return dirs;
}

interface Faults {
  createNew?: Error;
  openExisting?: Error;
  readFile?: Error;
  remove?: Error;
  writeMany?: Error;
  flush?: Error;
  dispose?: Error;
}

/**
 * An in-memory stand-in for Waffle storage with exclusive locks, directory tracking, and atomic
 * create-if-absent. Project files are keyed project-relative, metadata by its absolute path on
 * the filesystem root. Empty workspaces still exist as entries in `stores`.
 */
function storage(existing: Record<string, Record<string, string>> = {}) {
  const stores = new Map<string, StoreEntry>(
    Object.entries(existing).map(([id, files]) => [
      storageName(id),
      { files: new Map(Object.entries(files)), dirs: dirsForFiles(Object.keys(files)), locked: false },
    ]),
  );
  const log: string[] = [];
  const faults: Faults = {};
  let duringCreate: (id: string) => void = noop;
  let duringOpenExisting: (id: string) => void = noop;
  let duringReadMeta: () => void = noop;
  let duringWrite: () => void = noop;
  let onRemovePath: ((path: string) => Promise<void> | void) | undefined;

  function writer(id: string, entry: StoreEntry): WorkspaceWriter {
    return {
      files: {
        writeMany: async (files: Readonly<Record<string, string | Uint8Array>>) => {
          duringWrite();
          if (faults.writeMany) throw faults.writeMany;
          for (const [path, value] of Object.entries(files)) {
            if (entry.dirs.has(path)) throw new Error(`EISDIR: ${path} is a directory`);
            const parts = path.split("/");
            for (let i = 1; i < parts.length; i++) {
              const dir = parts.slice(0, i).join("/");
              if (entry.files.has(dir)) throw new Error(`ENOTDIR: ${dir} is a file`);
              entry.dirs.add(dir);
            }
            entry.files.set(path, String(value));
          }
          log.push("files");
        },
      },
      runtime: {
        filesystem: {
          readFile: async (path: string) => {
            if (path === WORKSPACE_META_PATH) duringReadMeta();
            if (faults.readFile) throw faults.readFile;
            const value = entry.files.get(path);
            return value === undefined ? undefined : new TextEncoder().encode(value);
          },
          writeFile: async (path: string, value: string | Uint8Array) => {
            entry.files.set(path, String(value));
            if (path === WORKSPACE_META_PATH) log.push(`meta ${metaState(entry.files)}`);
          },
          mkdirp: async () => undefined,
          remove: async (absolute: string) => {
            log.push(`remove ${absolute}`);
            if (onRemovePath) await onRemovePath(absolute);
            if (faults.remove) throw faults.remove;
            if (absolute === PROJECT_ROOT) {
              for (const key of Array.from(entry.files.keys())) {
                if (!key.startsWith("/")) entry.files.delete(key);
              }
              entry.dirs.clear();
              return;
            }
            const rel = absolute.slice(PROJECT_ROOT.length + 1);
            entry.files.delete(rel);
            entry.dirs.delete(rel);
            const prefix = `${rel}/`;
            for (const key of Array.from(entry.files.keys())) {
              if (key.startsWith(prefix)) entry.files.delete(key);
            }
            for (const dir of Array.from(entry.dirs)) {
              if (dir.startsWith(prefix)) entry.dirs.delete(dir);
            }
          },
          flush: async () => {
            if (faults.flush) throw faults.flush;
            log.push("flush");
          },
        },
      },
      dispose: async () => {
        entry.locked = false;
        log.push(`close ${id}`);
        if (faults.dispose) throw faults.dispose;
      },
    };
  }

  const deps = (ids: readonly string[] = []): NewWorkspaceDeps => {
    let index = 0;
    return {
      newId: () => ids[index++] ?? ids[ids.length - 1] ?? "exhausted",
      createNew: async (id, signal) => {
        signal?.throwIfAborted();
        duringCreate(id);
        if (faults.createNew) throw faults.createNew;
        const name = storageName(id);
        if (stores.has(name)) return "taken";
        const entry: StoreEntry = { files: new Map(), dirs: new Set(), locked: true };
        stores.set(name, entry);
        return writer(id, entry);
      },
      openExisting: async (id, signal) => {
        signal?.throwIfAborted();
        duringOpenExisting(id);
        if (faults.openExisting) throw faults.openExisting;
        const entry = stores.get(storageName(id));
        if (!entry) return "missing";
        if (entry.locked) return "busy";
        entry.locked = true;
        return writer(id, entry);
      },
    };
  };

  return {
    stores,
    log,
    faults,
    deps,
    files: (id: string) => Object.fromEntries(stores.get(storageName(id))?.files ?? []),
    dirs: (id: string) => Array.from(stores.get(storageName(id))?.dirs ?? []).toSorted(),
    isLocked: (id: string) => stores.get(storageName(id))?.locked ?? false,
    setLocked: (id: string, locked: boolean) => {
      const entry = stores.get(storageName(id));
      if (entry) entry.locked = locked;
    },
    onCreate: (hook: (id: string) => void) => (duringCreate = hook),
    onOpenExisting: (hook: (id: string) => void) => (duringOpenExisting = hook),
    onReadMeta: (hook: () => void) => (duringReadMeta = hook),
    onWrite: (hook: () => void) => (duringWrite = hook),
    onRemove: (hook: ((path: string) => Promise<void> | void) | undefined) => (onRemovePath = hook),
  };
}

describe("createWorkspaceWithFiles", () => {
  test("writes the marker first and clears it last, after the final flush", async () => {
    const store = storage();
    expect(await createWorkspaceWithFiles({ "a.txt": "a" }, META, store.deps(["fresh"]))).toBe("fresh");
    expect(store.log).toEqual([
      "meta importing",
      "flush",
      "files",
      "flush",
      "meta complete",
      "flush",
      "close fresh",
    ]);
    expect(parseMeta(store.files("fresh")[WORKSPACE_META_PATH])).toEqual(META);
    expect(store.isLocked("fresh")).toBe(false);
  });

  test("skips taken ids atomically, including an existing workspace with no files or metadata", async () => {
    // An existing workspace with only empty directories has zero listed files and no metadata yet.
    const store = storage({ emptyonly: {} });
    expect(await createWorkspaceWithFiles({ "a.txt": "a" }, META, store.deps(["emptyonly", "free"]))).toBe(
      "free",
    );
    expect(store.files("emptyonly")).toEqual({});
    expect(store.files("free")["a.txt"]).toBe("a");
  });

  test("fails with WorkspaceIdTakenError when every candidate collides with an empty existing workspace", async () => {
    const store = storage({ emptyonly: {} });
    await expect(
      createWorkspaceWithFiles({ "a.txt": "a" }, META, store.deps(["emptyonly"])),
    ).rejects.toBeInstanceOf(WorkspaceIdTakenError);
    expect(store.files("emptyonly")).toEqual({});
    expect(store.log).toEqual([]);
  });

  test("concurrent creations racing on the same candidate id never share a workspace", async () => {
    const store = storage();
    const [first, second] = await Promise.all([
      createWorkspaceWithFiles({ "one.txt": "1" }, META, store.deps(["same", "fallback1"])),
      createWorkspaceWithFiles({ "two.txt": "2" }, META, store.deps(["same", "fallback2"])),
    ]);
    expect(new Set([first, second]).size).toBe(2);
    expect(store.files(first)).toMatchObject({ "one.txt": "1" });
    expect(store.files(second)).toMatchObject({ "two.txt": "2" });
  });

  test("a cancel during a collided create never touches the existing workspace", async () => {
    const store = storage({ raced: { "node_modules/dep/index.js": "x" } });
    const controller = new AbortController();
    store.onCreate(() => controller.abort());
    const attempt = createWorkspaceWithFiles({ "a.txt": "a" }, META, store.deps(["raced", "next"]), {
      signal: controller.signal,
    });
    await expect(attempt).rejects.toThrow();
    expect(store.files("raced")).toEqual({ "node_modules/dep/index.js": "x" });
    expect(store.stores.has(storageName("next"))).toBe(false);
    expect(store.log).toEqual([]);
  });

  test("the metadata lives on the filesystem root, never inside the project", async () => {
    const store = storage();
    await createWorkspaceWithFiles({ "a.txt": "a" }, META, store.deps(["rooted"]));
    expect(Object.keys(store.files("rooted")).sort()).toEqual(["/.sprockt/workspace.json", "a.txt"]);
  });

  test("a failed createNew owns nothing and leaves no workspace behind", async () => {
    const store = storage();
    store.faults.createNew = new Error("worker failed");
    await expect(createWorkspaceWithFiles({ "a.txt": "a" }, META, store.deps(["half"]))).rejects.toThrow(
      "worker failed",
    );
    expect(store.stores.has(storageName("half"))).toBe(false);
  });

  test("a failure after the marker never deletes the workspace; it keeps the incomplete marker and closes", async () => {
    const store = storage();
    store.faults.writeMany = new Error("disk full");
    await expect(createWorkspaceWithFiles({ "a.txt": "a" }, META, store.deps(["broken"]))).rejects.toThrow(
      "disk full",
    );
    expect(store.stores.has(storageName("broken"))).toBe(true);
    expect(parseMeta(store.files("broken")[WORKSPACE_META_PATH])?.state).toBe(INCOMPLETE);
    expect(store.isLocked("broken")).toBe(false);
  });

  test("a cancel while writing never deletes the workspace; it keeps the incomplete marker and closes", async () => {
    const store = storage();
    const controller = new AbortController();
    store.onWrite(() => controller.abort());
    const attempt = createWorkspaceWithFiles({ "a.txt": "a" }, META, store.deps(["left"]), {
      signal: controller.signal,
    });
    await expect(attempt).rejects.toThrow();
    expect(store.stores.has(storageName("left"))).toBe(true);
    expect(parseMeta(store.files("left")[WORKSPACE_META_PATH])?.state).toBe(INCOMPLETE);
    expect(store.isLocked("left")).toBe(false);
  });

  test("a cancel during createNew still flushes the incomplete marker before aborting and closing", async () => {
    const store = storage();
    const controller = new AbortController();
    const baseDeps = store.deps(["midopen"]);
    const deps: NewWorkspaceDeps = {
      ...baseDeps,
      async createNew(id, signal) {
        const writer = await baseDeps.createNew(id, signal);
        controller.abort();
        return writer;
      },
    };
    await expect(
      createWorkspaceWithFiles({ "a.txt": "a" }, META, deps, { signal: controller.signal }),
    ).rejects.toThrow();
    expect(store.stores.has(storageName("midopen"))).toBe(true);
    expect(parseMeta(store.files("midopen")[WORKSPACE_META_PATH])?.state).toBe(INCOMPLETE);
    expect(store.files("midopen")["a.txt"]).toBeUndefined();
    expect(store.isLocked("midopen")).toBe(false);
  });

  test("a workspace whose marker is cleared is complete even if closing it fails", async () => {
    const store = storage();
    store.faults.dispose = new Error("worker gone");
    expect(await createWorkspaceWithFiles({ "a.txt": "a" }, META, store.deps(["done"]))).toBe("done");
    expect(parseMeta(store.files("done")[WORKSPACE_META_PATH])?.state).toBeUndefined();
  });
});

describe("Retry into an unfinished workspace", () => {
  const incomplete = serializeMeta({ ...META, state: INCOMPLETE });

  test("rewrites it in place when source matches, even if commit changed", async () => {
    const store = storage({
      cut: {
        [WORKSPACE_META_PATH]: serializeMeta({
          ...META,
          source: {
            kind: "github",
            owner: "acme",
            repo: "demo",
            ref: "feature/x",
            subdir: "apps/web",
            commit: "aaa",
          },
          state: INCOMPLETE,
        }),
        "stale.txt": "old",
        "a.txt": "half",
      },
    });
    const nextMeta: WorkspaceMeta = {
      ...META,
      source: {
        kind: "github",
        owner: "acme",
        repo: "demo",
        ref: "feature/x",
        subdir: "apps/web",
        commit: "bbb",
      },
    };
    const id = await createWorkspaceWithFiles({ "a.txt": "full", "b.txt": "b" }, nextMeta, store.deps(), {
      into: "cut",
    });
    expect(id).toBe("cut");
    const files = store.files("cut");
    expect(Object.keys(files).sort()).toEqual([WORKSPACE_META_PATH, "a.txt", "b.txt"].sort());
    expect(files["a.txt"]).toBe("full");
    expect(parseMeta(files[WORKSPACE_META_PATH])?.state).toBeUndefined();
    expect(store.isLocked("cut")).toBe(false);
  });

  test("retries an unfinished GitHub workspace whose stored metadata omitted template", async () => {
    const store = storage({
      cut: {
        [WORKSPACE_META_PATH]: incomplete,
        "stale.txt": "old",
      },
    });
    const nextMeta: WorkspaceMeta = { ...META, template: "github" };
    const id = await createWorkspaceWithFiles({ "a.txt": "full" }, nextMeta, store.deps(), { into: "cut" });
    expect(id).toBe("cut");
    expect(store.files("cut")).toEqual({
      [WORKSPACE_META_PATH]: serializeMeta(nextMeta),
      "a.txt": "full",
    });
    expect(store.isLocked("cut")).toBe(false);
  });

  test("clears stale directories so a directory can become a file on a newer commit while preserving metadata", async () => {
    const store = storage({
      cut: {
        [WORKSPACE_META_PATH]: incomplete,
        "assets/logo.svg": "<svg/>",
        "old/nested/file.txt": "stale",
      },
    });
    expect(store.dirs("cut")).toEqual(["assets", "old", "old/nested"]);

    const id = await createWorkspaceWithFiles({ assets: "plain file now" }, META, store.deps(), {
      into: "cut",
    });
    expect(id).toBe("cut");
    expect(store.files("cut")).toEqual({
      [WORKSPACE_META_PATH]: serializeMeta(META),
      assets: "plain file now",
    });
    expect(store.dirs("cut")).toEqual([]);
    expect(store.isLocked("cut")).toBe(false);
  });

  test("a failed retry keeps the workspace, its marker, and closes the writer", async () => {
    const store = storage({ cut: { [WORKSPACE_META_PATH]: incomplete } });
    store.faults.writeMany = new Error("disk full");
    await expect(
      createWorkspaceWithFiles({ "a.txt": "a" }, META, store.deps(), { into: "cut" }),
    ).rejects.toThrow("disk full");
    expect(store.stores.has(storageName("cut"))).toBe(true);
    expect(parseMeta(store.files("cut")[WORKSPACE_META_PATH])?.state).toBe(INCOMPLETE);
    expect(store.isLocked("cut")).toBe(false);
  });

  test("refuses a workspace that is not an unfinished import, changes nothing, and closes", async () => {
    const store = storage({ done: { [WORKSPACE_META_PATH]: serializeMeta(META), "mine.txt": "x" } });
    await expect(
      createWorkspaceWithFiles({ "a.txt": "a" }, META, store.deps(), { into: "done" }),
    ).rejects.toBeInstanceOf(NotIncompleteError);
    expect(store.files("done")["mine.txt"]).toBe("x");
    expect(store.isLocked("done")).toBe(false);
  });

  test("refuses a missing workspace without creating it", async () => {
    const store = storage();
    await expect(
      createWorkspaceWithFiles({ "a.txt": "a" }, META, store.deps(), { into: "gone" }),
    ).rejects.toBeInstanceOf(WorkspaceMissingError);
    expect(store.stores.has(storageName("gone"))).toBe(false);
  });

  test("refuses a busy workspace held by another tab without touching its files", async () => {
    const store = storage({ busy: { [WORKSPACE_META_PATH]: incomplete, "keep.txt": "live" } });
    store.setLocked("busy", true);
    await expect(
      createWorkspaceWithFiles({ "a.txt": "a" }, META, store.deps(), { into: "busy" }),
    ).rejects.toBeInstanceOf(WorkspaceBusyError);
    expect(store.files("busy")["keep.txt"]).toBe("live");
    expect(store.isLocked("busy")).toBe(true);
  });

  test("two concurrent retries serialize exclusively so the loser cannot clear files the winner wrote", async () => {
    const store = storage({ race: { [WORKSPACE_META_PATH]: incomplete, "stale.txt": "old" } });
    const [first, second] = await Promise.allSettled([
      createWorkspaceWithFiles({ "winner.txt": "ok" }, META, store.deps(), { into: "race" }),
      createWorkspaceWithFiles({ "loser.txt": "no" }, META, store.deps(), { into: "race" }),
    ]);
    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("rejected");
    expect(second.status === "rejected" && second.reason).toBeInstanceOf(WorkspaceBusyError);
    expect(store.files("race")).toMatchObject({ "winner.txt": "ok" });
    expect(store.files("race")["loser.txt"]).toBeUndefined();
    expect(store.isLocked("race")).toBe(false);
  });

  test("refuses a retry for a different GitHub owner, repo, ref, or subdir without clearing files", async () => {
    const store = storage({ cut: { [WORKSPACE_META_PATH]: incomplete, "stale.txt": "keep" } });
    const mismatches: WorkspaceMeta[] = [
      {
        ...META,
        source: { kind: "github", owner: "other", repo: "demo", ref: "feature/x", subdir: "apps/web" },
      },
      {
        ...META,
        source: { kind: "github", owner: "acme", repo: "other", ref: "feature/x", subdir: "apps/web" },
      },
      { ...META, source: { kind: "github", owner: "acme", repo: "demo", ref: "main", subdir: "apps/web" } },
      { ...META, source: { kind: "github", owner: "acme", repo: "demo", ref: "feature/x", subdir: "" } },
      { name: "hono", created: META.created, template: "hono" },
    ];
    for (const wrong of mismatches) {
      // Sequential checks verify each mismatch leaves storage unlocked and intact.
      // oxlint-disable-next-line no-await-in-loop
      await expect(
        createWorkspaceWithFiles({ "a.txt": "a" }, wrong, store.deps(), { into: "cut" }),
      ).rejects.toBeInstanceOf(RetrySourceMismatchError);
      expect(store.files("cut")["stale.txt"]).toBe("keep");
      expect(store.isLocked("cut")).toBe(false);
    }
  });

  test("refuses retrying an unfinished share workspace", async () => {
    const shareMeta: WorkspaceMeta = {
      name: "Shared workspace",
      created: META.created,
      source: { kind: "share", template: "blank" },
    };
    const store = storage({
      shared: { [WORKSPACE_META_PATH]: serializeMeta({ ...shareMeta, state: INCOMPLETE }), "a.txt": "keep" },
    });
    await expect(
      createWorkspaceWithFiles({ "a.txt": "new" }, shareMeta, store.deps(), { into: "shared" }),
    ).rejects.toBeInstanceOf(RetrySourceMismatchError);
    expect(store.files("shared")["a.txt"]).toBe("keep");
    expect(store.isLocked("shared")).toBe(false);
  });

  test("checks cancellation before clearing the project subtree and closes the writer", async () => {
    const store = storage({ cut: { [WORKSPACE_META_PATH]: incomplete, "assets/logo.svg": "<svg/>" } });
    const controller = new AbortController();
    store.onReadMeta(() => controller.abort());
    await expect(
      createWorkspaceWithFiles({ "a.txt": "a" }, META, store.deps(), {
        into: "cut",
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(store.files("cut")["assets/logo.svg"]).toBe("<svg/>");
    expect(store.dirs("cut")).toEqual(["assets"]);
    expect(store.log.filter((entry) => entry.startsWith("remove"))).toEqual([]);
    expect(store.isLocked("cut")).toBe(false);
  });

  test("checks cancellation after clearing before writing new files and closes the writer", async () => {
    const store = storage({ cut: { [WORKSPACE_META_PATH]: incomplete, "stale.txt": "keep" } });
    const controller = new AbortController();
    store.onRemove(() => controller.abort());
    await expect(
      createWorkspaceWithFiles({ "a.txt": "a" }, META, store.deps(), {
        into: "cut",
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(store.log.filter((entry) => entry === "files")).toEqual([]);
    expect(store.isLocked("cut")).toBe(false);
  });

  test("closes the writer when readMetaFile or subtree removal fails", async () => {
    const readStore = storage({ cut: { [WORKSPACE_META_PATH]: incomplete } });
    readStore.faults.readFile = new Error("read boom");
    await expect(
      createWorkspaceWithFiles({ "a.txt": "a" }, META, readStore.deps(), { into: "cut" }),
    ).rejects.toThrow("read boom");
    expect(readStore.isLocked("cut")).toBe(false);

    const removeStore = storage({
      cut: { [WORKSPACE_META_PATH]: incomplete, "assets/logo.svg": "<svg/>" },
    });
    removeStore.faults.remove = new Error("remove boom");
    await expect(
      createWorkspaceWithFiles({ "c.txt": "3" }, META, removeStore.deps(), { into: "cut" }),
    ).rejects.toThrow("remove boom");
    expect(removeStore.isLocked("cut")).toBe(false);
  });
});

/** Waffle's idle opener answering with `answer`, recording each close. */
function idle(answer: "busy" | "missing" | WorkspaceMeta, closed: string[]): OpenIdle {
  return async () => {
    if (answer === "busy" || answer === "missing") return answer;
    return {
      readFile: async (path: string) => (path === WORKSPACE_META_PATH ? encode(answer) : undefined),
      close: async () => void closed.push("closed"),
    };
  };
}

describe("finding unfinished workspaces", () => {
  test("reports only workspaces whose marker is set, and closes what it opened", async () => {
    const closed: string[] = [];
    expect(await readIncomplete("a", idle({ ...META, state: INCOMPLETE }, closed))).toMatchObject({
      name: "demo",
    });
    expect(await readIncomplete("b", idle(META, closed))).toBeUndefined();
    expect(await readIncomplete("c", idle("busy", closed))).toBeUndefined();
    expect(await readIncomplete("d", idle("missing", closed))).toBeUndefined();
    expect(closed).toEqual(["closed", "closed"]);
  });

  test("Retry re-imports the recorded GitHub source into the same workspace", () => {
    const path = retryPath("cut1", META);
    expect(path).toBe("/github/acme/demo/tree/feature%2Fx/apps/web?into=cut1");
    expect(parseRoute((path ?? "").split("?")[0] ?? "")).toEqual({
      kind: "github",
      owner: "acme",
      repo: "demo",
      branch: "feature/x",
      subdir: "apps/web",
    });
    expect(retryPath("s", { ...META, source: { kind: "share", template: "blank" } })).toBeUndefined();
  });
});

function meteredProjectFilesystem(initial: Readonly<Record<string, string>> = {}, quota = 1024) {
  const textEncoder = new TextEncoder();
  const files = new Map<string, Uint8Array>(
    Object.entries(initial).map(([path, text]) => [path, textEncoder.encode(text)]),
  );
  const directories = new Set<string>(["/", PROJECT_ROOT]);
  for (const path of files.keys()) {
    const parts = path.split("/").filter(Boolean);
    for (let index = 0; index < parts.length - 1; index += 1) {
      directories.add(`/${parts.slice(0, index + 1).join("/")}`);
    }
  }
  let inFlight = 0;
  let peak = 0;

  async function track<T>(work: () => T | Promise<T>): Promise<T> {
    inFlight += 1;
    if (inFlight > peak) peak = inFlight;
    if (inFlight > quota) {
      inFlight -= 1;
      throw new Error("filesystem outstanding request quota exhausted");
    }
    try {
      await Promise.resolve();
      return await work();
    } finally {
      inFlight -= 1;
    }
  }

  const filesystem: ProjectFilesystem = {
    mkdirp: (path) =>
      track(() => {
        const parts = path.split("/").filter(Boolean);
        for (let index = 0; index < parts.length; index += 1) {
          directories.add(`/${parts.slice(0, index + 1).join("/")}`);
        }
      }),
    writeFile: (path, content) =>
      track(() => {
        files.set(path, typeof content === "string" ? textEncoder.encode(content) : content);
      }),
    readFile: (path) => track(() => files.get(path)),
    listFiles: (path) => track(() => Array.from(files.keys()).filter((file) => file.startsWith(`${path}/`))),
    remove: (path) =>
      track(() => {
        const prefix = `${path}/`;
        let removed = false;
        for (const key of Array.from(files.keys())) {
          if (key === path || key.startsWith(prefix)) {
            files.delete(key);
            removed = true;
          }
        }
        for (const dir of Array.from(directories)) {
          if (dir === path || dir.startsWith(prefix)) directories.delete(dir);
        }
        return removed;
      }),
    move: () => track(() => undefined),
    flush: () => track(() => undefined),
    lookup: (path) =>
      track(() => {
        if (files.has(path)) return { kind: "file" };
        return directories.has(path) ? { kind: "dir", children: new Map() } : undefined;
      }),
    resolvePath: (path): Promise<ResolvedEntry | undefined> =>
      track(() => {
        if (files.has(path)) return { path, kind: "file" };
        if (directories.has(path)) return { path, kind: "dir" };
        const parent = path.slice(0, path.lastIndexOf("/")) || "/";
        if (parent === "/" || directories.has(parent)) return undefined;
        throw Object.assign(new Error("filesystem errno 44"), { errno: 44 });
      }),
  };

  return {
    filesystem,
    files,
    get peak() {
      return peak;
    },
  };
}

function numberedFiles(count: number, prefix: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (let index = 0; index < count; index += 1) {
    files[`pkg-${Math.floor(index / 25)}/${prefix}-${index}.ts`] = `export const n = ${index};\n`;
  }
  return files;
}

describe("bulk imports over 1,024 files and nameless metadata recovery", () => {
  test("imports 1,500 files through real ProjectFiles with bounded concurrent RPCs", async () => {
    const metered = meteredProjectFilesystem();
    const projectFiles = createProjectFiles(metered.filesystem, () => () => {});
    const deps: NewWorkspaceDeps = {
      newId: () => "large",
      createNew: async () => ({
        files: projectFiles,
        runtime: { filesystem: metered.filesystem },
        dispose: async () => projectFiles.dispose(),
      }),
      openExisting: async () => "missing",
    };

    const id = await createWorkspaceWithFiles(numberedFiles(1500, "file"), META, deps);
    expect(id).toBe("large");
    expect(metered.peak).toBeLessThanOrEqual(8);
    expect(metered.files.has(`${PROJECT_ROOT}/pkg-0/file-0.ts`)).toBe(true);
    expect(metered.files.has(`${PROJECT_ROOT}/pkg-59/file-1499.ts`)).toBe(true);
    const metaBytes = metered.files.get(WORKSPACE_META_PATH);
    expect(parseMeta(metaBytes && new TextDecoder().decode(metaBytes))?.state).toBeUndefined();
  });

  test("Retry cleans up 1,500 stale files via subtree removal and writes 1,500 new files with bounded RPCs", async () => {
    const stale: Record<string, string> = {
      [WORKSPACE_META_PATH]: serializeMeta({ ...META, state: INCOMPLETE }),
    };
    for (let index = 0; index < 1500; index += 1) {
      stale[`${PROJECT_ROOT}/old-${Math.floor(index / 25)}/stale-${index}.ts`] = "old";
    }
    const metered = meteredProjectFilesystem(stale);
    const projectFiles = createProjectFiles(metered.filesystem, () => () => {});
    const deps: NewWorkspaceDeps = {
      createNew: async () => "taken",
      openExisting: async () => ({
        files: projectFiles,
        runtime: { filesystem: metered.filesystem },
        dispose: async () => projectFiles.dispose(),
      }),
    };

    const fresh = numberedFiles(1500, "fresh");
    const id = await createWorkspaceWithFiles(fresh, META, deps, { into: "cut" });
    expect(id).toBe("cut");
    expect(metered.peak).toBeLessThanOrEqual(8);
    const expectedPaths = [WORKSPACE_META_PATH]
      .concat(Object.keys(fresh).map((path) => `${PROJECT_ROOT}/${path}`))
      .sort();
    expect(Array.from(metered.files.keys()).sort()).toEqual(expectedPaths);
    const metaBytes = metered.files.get(WORKSPACE_META_PATH);
    expect(parseMeta(metaBytes && new TextDecoder().decode(metaBytes))).toEqual(META);
  });

  test("Retry accepts an incomplete GitHub import whose workspace.json omits or nulls name", async () => {
    const retryMeta: WorkspaceMeta = {
      ...META,
      source: { kind: "github", owner: "acme", repo: "demo", ref: "main", subdir: "apps/web" },
    };
    const namelessIncomplete = JSON.stringify({
      state: INCOMPLETE,
      created: "2026-04-01T00:00:00.000Z",
      source: { kind: "github", owner: "acme", repo: "demo", ref: "main", subdir: "apps/web" },
    });
    const nullNameIncomplete = JSON.stringify({
      name: null,
      state: INCOMPLETE,
      created: "2026-04-01T00:00:00.000Z",
      source: { kind: "github", owner: "acme", repo: "demo", ref: "main", subdir: "apps/web" },
    });
    expect(parseMeta(namelessIncomplete)).toMatchObject({ name: "web", state: INCOMPLETE });
    expect(parseMeta(nullNameIncomplete)).toMatchObject({ name: "web", state: INCOMPLETE });

    const metered = meteredProjectFilesystem({
      [WORKSPACE_META_PATH]: nullNameIncomplete,
      [`${PROJECT_ROOT}/stale.txt`]: "old",
    });
    const projectFiles = createProjectFiles(metered.filesystem, () => () => {});
    const deps: NewWorkspaceDeps = {
      createNew: async () => "taken",
      openExisting: async () => ({
        files: projectFiles,
        runtime: { filesystem: metered.filesystem },
        dispose: async () => projectFiles.dispose(),
      }),
    };

    const id = await createWorkspaceWithFiles({ "index.ts": "export const ok = 1;\n" }, retryMeta, deps, {
      into: "nameless1",
    });
    expect(id).toBe("nameless1");
    expect(metered.files.has(`${PROJECT_ROOT}/stale.txt`)).toBe(false);
    expect(metered.files.has(`${PROJECT_ROOT}/index.ts`)).toBe(true);
    const metaBytes = metered.files.get(WORKSPACE_META_PATH);
    expect(parseMeta(metaBytes && new TextDecoder().decode(metaBytes))).toEqual(retryMeta);
  });
});
