import { describe, expect, test } from "bun:test";
import { createProjectFiles, type ProjectFilesystem, type ResolvedEntry } from "../files/project-files";
import { withWorkspaceMetaLock } from "../workspace/hint";
import { PROJECT_ROOT } from "../workspace/paths";
import { readIncomplete, retryPath, type OpenIdle } from "./incomplete";
import { INCOMPLETE, parseMeta, serializeMeta, WORKSPACE_META_PATH, type WorkspaceMeta } from "./metadata";
import {
  createWorkspaceWithFiles,
  NotIncompleteError,
  WorkspaceIdTakenError,
  type NewWorkspaceDeps,
} from "./new-workspace";
import { parseRoute } from "../app/routes";

const META: WorkspaceMeta = {
  name: "demo",
  created: "2026-11-25T00:00:00.000Z",
  source: { kind: "github", owner: "acme", repo: "demo", ref: "feature/x", subdir: "apps/web" },
};

type Files = Map<string, string>;

function noop(): void {}

const encode = (meta: WorkspaceMeta) => new TextEncoder().encode(serializeMeta(meta));

/**
 * An in-memory stand-in for Waffle storage. Project files are keyed project-relative, as
 * FileService takes them; the metadata is keyed by its absolute path on the filesystem root,
 * which only the raw filesystem reaches. The raw project listing returns absolute paths and,
 * unlike FileService, includes node_modules and .git. `log` records writes, flushes and deletes.
 */
function storage(existing: Record<string, Record<string, string>> = {}) {
  const stores = new Map<string, Files>(
    Object.entries(existing).map(([id, files]) => [`sprockt-${id}`, new Map(Object.entries(files))]),
  );
  const log: string[] = [];
  const faults: { writeMany?: Error; open?: Error; removeAnswer?: string; dispose?: Error } = {};
  let duringOpen: () => void = noop;
  let duringWrite: () => void = noop;

  const metaState = (store: Files) => parseMeta(store.get(WORKSPACE_META_PATH))?.state ?? "complete";

  const projectPaths = (store: Files) => Array.from(store.keys()).filter((path) => !path.startsWith("/"));

  function session(id: string, store: Files) {
    return {
      files: {
        writeMany: async (files: Readonly<Record<string, string | Uint8Array>>) => {
          duringWrite();
          if (faults.writeMany) throw faults.writeMany;
          for (const [path, value] of Object.entries(files)) store.set(path, String(value));
          log.push("files");
        },
      },
      runtime: {
        filesystem: {
          listFiles: async () => projectPaths(store).map((path) => `${PROJECT_ROOT}/${path}`),
          readFile: async (path: string) => {
            const value = store.get(path);
            return value === undefined ? undefined : new TextEncoder().encode(value);
          },
          writeFile: async (path: string, value: string | Uint8Array) => {
            store.set(path, String(value));
            if (path === WORKSPACE_META_PATH) log.push(`meta ${metaState(store)}`);
          },
          mkdirp: async () => undefined,
          remove: async (absolute: string) => void store.delete(absolute.slice(PROJECT_ROOT.length + 1)),
          flush: async () => void log.push("flush"),
        },
      },
      dispose: async () => {
        log.push(`close ${id}`);
        if (faults.dispose) throw faults.dispose;
      },
    } as never;
  }

  const deps = (ids: string[]): NewWorkspaceDeps => ({
    newId: () => ids.shift() ?? "exhausted",
    exists: async (name) => stores.has(name),
    remove: async (name) => {
      log.push(`delete ${name}`);
      if (faults.removeAnswer) return faults.removeAnswer;
      stores.delete(name);
      return "deleted";
    },
    open: async (id) => {
      duringOpen();
      if (faults.open) throw faults.open;
      const store = stores.get(`sprockt-${id}`) ?? new Map();
      stores.set(`sprockt-${id}`, store);
      return session(id, store);
    },
  });

  return {
    stores,
    log,
    faults,
    deps,
    files: (id: string) => Object.fromEntries(stores.get(`sprockt-${id}`) ?? []),
    onOpen: (hook: () => void) => (duringOpen = hook),
    onWrite: (hook: () => void) => (duringWrite = hook),
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
  });

  test("takes the next free id when one is already stored", async () => {
    const store = storage({ taken: { "mine.txt": "keep me" } });
    expect(await createWorkspaceWithFiles({ "a.txt": "a" }, META, store.deps(["taken", "free"]))).toBe(
      "free",
    );
    expect(store.files("taken")).toEqual({ "mine.txt": "keep me" });
  });

  test("a cancel during the open of a workspace someone else just created never deletes it", async () => {
    // Created between the id check and the open; it holds only node_modules, which FileService
    // listings hide, so only the raw listing shows it is not empty.
    const store = storage({ raced: { "node_modules/dep/index.js": "x" } });
    const controller = new AbortController();
    store.onOpen(() => controller.abort());
    const deps = { ...store.deps(["raced"]), exists: async () => false };
    const attempt = createWorkspaceWithFiles({ "a.txt": "a" }, META, deps, { signal: controller.signal });
    await expect(attempt).rejects.toBeInstanceOf(WorkspaceIdTakenError);
    expect(store.files("raced")).toEqual({ "node_modules/dep/index.js": "x" });
    expect(store.log.filter((entry) => entry.startsWith("delete") || entry.startsWith("meta"))).toEqual([]);
  });

  test("a workspace with metadata but no project files (a blank one) is not ours either", async () => {
    const store = storage({ blank: { [WORKSPACE_META_PATH]: serializeMeta(META) } });
    const deps = { ...store.deps(["blank"]), exists: async () => false };
    await expect(createWorkspaceWithFiles({ "a.txt": "a" }, META, deps)).rejects.toBeInstanceOf(
      WorkspaceIdTakenError,
    );
    expect(store.files("blank")).toEqual({ [WORKSPACE_META_PATH]: serializeMeta(META) });
  });

  test("the metadata lives on the filesystem root, never inside the project", async () => {
    const store = storage();
    await createWorkspaceWithFiles({ "a.txt": "a" }, META, store.deps(["rooted"]));
    expect(Object.keys(store.files("rooted")).sort()).toEqual(["/.sprockt/workspace.json", "a.txt"]);
  });

  test("a failed open owns nothing, so nothing is deleted", async () => {
    const store = storage();
    store.faults.open = new Error("worker failed");
    await expect(createWorkspaceWithFiles({ "a.txt": "a" }, META, store.deps(["half"]))).rejects.toThrow(
      "worker failed",
    );
    expect(store.log.filter((entry) => entry.startsWith("delete"))).toEqual([]);
  });

  test("a failure after the marker deletes the workspace this call created", async () => {
    const store = storage();
    store.faults.writeMany = new Error("disk full");
    await expect(createWorkspaceWithFiles({ "a.txt": "a" }, META, store.deps(["broken"]))).rejects.toThrow(
      "disk full",
    );
    expect(store.stores.has("sprockt-broken")).toBe(false);
  });

  test("if that delete is busy, the marker stays so the landing page can offer Retry and Delete", async () => {
    const store = storage();
    store.faults.writeMany = new Error("disk full");
    store.faults.removeAnswer = "busy";
    await expect(createWorkspaceWithFiles({ "a.txt": "a" }, META, store.deps(["stuck"]))).rejects.toThrow();
    expect(parseMeta(store.files("stuck")[WORKSPACE_META_PATH])?.state).toBe(INCOMPLETE);
  });

  test("a cancel while writing deletes the workspace this call created", async () => {
    const store = storage();
    const controller = new AbortController();
    store.onWrite(() => controller.abort());
    const attempt = createWorkspaceWithFiles({ "a.txt": "a" }, META, store.deps(["left"]), {
      signal: controller.signal,
    });
    await expect(attempt).rejects.toThrow();
    expect(store.stores.has("sprockt-left")).toBe(false);
  });

  test("a workspace whose marker is cleared is complete even if closing it fails", async () => {
    const store = storage();
    store.faults.dispose = new Error("worker gone");
    expect(await createWorkspaceWithFiles({ "a.txt": "a" }, META, store.deps(["done"]))).toBe("done");
    expect(parseMeta(store.files("done")[WORKSPACE_META_PATH])?.state).toBeUndefined();
    expect(store.log.filter((entry) => entry.startsWith("delete"))).toEqual([]);
  });
});

describe("Retry into an unfinished workspace", () => {
  const incomplete = serializeMeta({ ...META, state: INCOMPLETE });

  test("rewrites it in place: stale files go, the new set and cleared marker land, nothing is deleted", async () => {
    const store = storage({
      cut: { [WORKSPACE_META_PATH]: incomplete, "stale.txt": "old", "a.txt": "half" },
    });
    const id = await createWorkspaceWithFiles({ "a.txt": "full", "b.txt": "b" }, META, store.deps([]), {
      into: "cut",
    });
    expect(id).toBe("cut");
    const files = store.files("cut");
    expect(Object.keys(files).sort()).toEqual([WORKSPACE_META_PATH, "a.txt", "b.txt"].sort());
    expect(files["a.txt"]).toBe("full");
    expect(parseMeta(files[WORKSPACE_META_PATH])?.state).toBeUndefined();
    expect(store.log.filter((entry) => entry.startsWith("delete"))).toEqual([]);
  });

  test("a failed retry keeps the workspace and its marker", async () => {
    const store = storage({ cut: { [WORKSPACE_META_PATH]: incomplete } });
    store.faults.writeMany = new Error("disk full");
    await expect(
      createWorkspaceWithFiles({ "a.txt": "a" }, META, store.deps([]), { into: "cut" }),
    ).rejects.toThrow();
    expect(store.stores.has("sprockt-cut")).toBe(true);
    expect(parseMeta(store.files("cut")[WORKSPACE_META_PATH])?.state).toBe(INCOMPLETE);
  });

  test("refuses a workspace that is not an unfinished import, and changes nothing", async () => {
    const store = storage({ done: { [WORKSPACE_META_PATH]: serializeMeta(META), "mine.txt": "x" } });
    await expect(
      createWorkspaceWithFiles({ "a.txt": "a" }, META, store.deps([]), { into: "done" }),
    ).rejects.toBeInstanceOf(NotIncompleteError);
    expect(store.files("done")["mine.txt"]).toBe("x");
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
  const encoder = new TextEncoder();
  const files = new Map<string, Uint8Array>(
    Object.entries(initial).map(([path, text]) => [path, encoder.encode(text)]),
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
        files.set(path, typeof content === "string" ? encoder.encode(content) : content);
      }),
    readFile: (path) => track(() => files.get(path)),
    listFiles: (path) => track(() => Array.from(files.keys()).filter((file) => file.startsWith(`${path}/`))),
    remove: (path) => track(() => files.delete(path)),
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

describe("bulk imports over 1,024 files", () => {
  test("imports 1,500 files through real ProjectFiles with bounded concurrent RPCs", async () => {
    const metered = meteredProjectFilesystem();
    const projectFiles = createProjectFiles(metered.filesystem, () => () => {});
    const deps: NewWorkspaceDeps = {
      newId: () => "large",
      exists: async () => false,
      remove: async () => "deleted",
      open: async () => ({
        files: projectFiles,
        runtime: { filesystem: metered.filesystem },
        dispose: async () => projectFiles.dispose(),
      }),
    };

    const id = await createWorkspaceWithFiles(numberedFiles(1500, "file"), META, deps);
    expect(id).toBe("large");
    expect(metered.peak).toBeLessThanOrEqual(8);
    expect(metered.files.has(`${PROJECT_ROOT}/pkg-0/file-0.ts`)).toBe(true);
    expect(metered.files.has(`${PROJECT_ROOT}/pkg-59/file-1499.ts`)).toBe(true);
    const metaBytes = metered.files.get(WORKSPACE_META_PATH);
    expect(parseMeta(metaBytes && new TextDecoder().decode(metaBytes))?.state).toBeUndefined();
  });

  test("Retry cleans up 1,500 stale files and writes 1,500 new files with bounded concurrent RPCs", async () => {
    const stale: Record<string, string> = {
      [WORKSPACE_META_PATH]: serializeMeta({ ...META, state: INCOMPLETE }),
    };
    for (let index = 0; index < 1500; index += 1) {
      stale[`${PROJECT_ROOT}/old-${Math.floor(index / 25)}/stale-${index}.ts`] = "old";
    }
    const metered = meteredProjectFilesystem(stale);
    const projectFiles = createProjectFiles(metered.filesystem, () => () => {});
    const deps: NewWorkspaceDeps = {
      exists: async () => true,
      remove: async () => "deleted",
      open: async () => ({
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

  test("Retry closes the session and keeps the marker if stale cleanup fails", async () => {
    let closed = false;
    const stale: Record<string, string> = {
      [WORKSPACE_META_PATH]: serializeMeta({ ...META, state: INCOMPLETE }),
      [`${PROJECT_ROOT}/stale.txt`]: "old",
    };
    const metered = meteredProjectFilesystem(stale);
    const failingFs = {
      ...metered.filesystem,
      remove: async () => {
        throw new Error("remove failed");
      },
    };
    const deps: NewWorkspaceDeps = {
      exists: async () => true,
      remove: async () => "deleted",
      open: async () => ({
        files: { writeMany: async () => undefined },
        runtime: { filesystem: failingFs },
        dispose: async () => {
          closed = true;
        },
      }),
    };

    await expect(createWorkspaceWithFiles({ "a.txt": "a" }, META, deps, { into: "cut" })).rejects.toThrow(
      "remove failed",
    );
    expect(closed).toBe(true);
    const metaBytes = metered.files.get(WORKSPACE_META_PATH);
    expect(parseMeta(metaBytes && new TextDecoder().decode(metaBytes))?.state).toBe(INCOMPLETE);
  });

  test("Retry waits for pending sibling removals to settle before closing when another removal throws synchronously", async () => {
    let closed = false;
    const pendingRemoval = Promise.withResolvers<boolean>();
    const stale: Record<string, string> = {
      [WORKSPACE_META_PATH]: serializeMeta({ ...META, state: INCOMPLETE }),
      [`${PROJECT_ROOT}/slow.txt`]: "slow",
      [`${PROJECT_ROOT}/sync-boom.txt`]: "boom",
    };
    const metered = meteredProjectFilesystem(stale);
    const failingFs = {
      ...metered.filesystem,
      remove: (path: string) => {
        if (path === `${PROJECT_ROOT}/slow.txt`) return pendingRemoval.promise;
        if (path === `${PROJECT_ROOT}/sync-boom.txt`) throw new Error("sync remove boom");
        return metered.filesystem.remove(path);
      },
    };
    const deps: NewWorkspaceDeps = {
      exists: async () => true,
      remove: async () => "deleted",
      open: async () => ({
        files: { writeMany: async () => undefined },
        runtime: { filesystem: failingFs },
        dispose: async () => {
          closed = true;
        },
      }),
    };

    const attempt = createWorkspaceWithFiles({ "a.txt": "a" }, META, deps, { into: "cut" }).catch(
      (error: unknown) => error,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(closed).toBe(false);

    pendingRemoval.reject(new Error("late sibling rejection"));
    const error = await attempt;
    expect(error).toEqual(new Error("late sibling rejection"));
    expect(closed).toBe(true);
    const metaBytes = metered.files.get(WORKSPACE_META_PATH);
    expect(parseMeta(metaBytes && new TextDecoder().decode(metaBytes))?.state).toBe(INCOMPLETE);
  });

  test("Retry accepts an incomplete GitHub import whose workspace.json omits or nulls name", async () => {
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
      exists: async () => true,
      remove: async () => "deleted",
      open: async () => ({
        files: projectFiles,
        runtime: { filesystem: metered.filesystem },
        dispose: async () => projectFiles.dispose(),
      }),
    };

    const id = await createWorkspaceWithFiles({ "index.ts": "export const ok = 1;\n" }, META, deps, {
      into: "nameless1",
    });
    expect(id).toBe("nameless1");
    expect(metered.files.has(`${PROJECT_ROOT}/stale.txt`)).toBe(false);
    expect(metered.files.has(`${PROJECT_ROOT}/index.ts`)).toBe(true);
    const metaBytes = metered.files.get(WORKSPACE_META_PATH);
    expect(parseMeta(metaBytes && new TextDecoder().decode(metaBytes))).toEqual(META);
  });

  test("cancellation while waiting for the final metadata lock leaves the incomplete marker intact", async () => {
    const id = "cancelmeta";
    const metered = meteredProjectFilesystem();
    const projectFiles = createProjectFiles(metered.filesystem, () => () => {});
    const lockGate = Promise.withResolvers<void>();
    const lockStarted = Promise.withResolvers<void>();
    let holder: Promise<void> | undefined;
    const writeAndHold = async (entries: Readonly<Record<string, string | Uint8Array>>) => {
      await projectFiles.writeMany(entries);
      holder = withWorkspaceMetaLock(id, async () => {
        lockStarted.resolve();
        await lockGate.promise;
      });
      await lockStarted.promise;
    };
    const deps: NewWorkspaceDeps = {
      newId: () => id,
      exists: async () => false,
      remove: async () => "busy",
      open: async () => ({
        files: { writeMany: writeAndHold },
        runtime: { filesystem: metered.filesystem },
        dispose: async () => projectFiles.dispose(),
      }),
    };

    const controller = new AbortController();
    const attempt = createWorkspaceWithFiles({ "index.ts": "export const ok = 1;\n" }, META, deps, {
      signal: controller.signal,
    }).catch((error: unknown) => error);

    await lockStarted.promise;
    controller.abort(new Error("cancelled by user"));
    lockGate.resolve();
    await holder;

    const outcome = await attempt;
    expect(outcome).toBeInstanceOf(Error);
    const metaBytes = metered.files.get(WORKSPACE_META_PATH);
    expect(parseMeta(metaBytes && new TextDecoder().decode(metaBytes))?.state).toBe(INCOMPLETE);
  });

  test("cancellation during open still writes the incomplete marker if rollback is busy", async () => {
    const metered = meteredProjectFilesystem();
    const projectFiles = createProjectFiles(metered.filesystem, () => () => {});
    const controller = new AbortController();
    const deps: NewWorkspaceDeps = {
      newId: () => "busycncl",
      exists: async () => false,
      remove: async () => "busy",
      open: async () => {
        // User leaves while storage is opening.
        controller.abort(new Error("left during open"));
        return {
          files: projectFiles,
          runtime: { filesystem: metered.filesystem },
          dispose: async () => projectFiles.dispose(),
        };
      },
    };

    const outcome = await createWorkspaceWithFiles({ "index.ts": "1" }, META, deps, {
      signal: controller.signal,
    }).catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(Error);
    const metaBytes = metered.files.get(WORKSPACE_META_PATH);
    expect(parseMeta(metaBytes && new TextDecoder().decode(metaBytes))?.state).toBe(INCOMPLETE);
  });

  test("cancelling Retry while the metadata lock is held aborts immediately without leaving a runtime open", async () => {
    const id = "retrycncl";
    const metered = meteredProjectFilesystem({
      [WORKSPACE_META_PATH]: serializeMeta({ ...META, state: INCOMPLETE }),
    });
    const projectFiles = createProjectFiles(metered.filesystem, () => () => {});
    const lockGate = Promise.withResolvers<void>();
    const lockStarted = Promise.withResolvers<void>();
    const holder = withWorkspaceMetaLock(id, async () => {
      lockStarted.resolve();
      await lockGate.promise;
    });
    await lockStarted.promise;

    let openCount = 0;
    const deps: NewWorkspaceDeps = {
      exists: async () => true,
      remove: async () => "deleted",
      open: async () => {
        openCount += 1;
        return {
          files: projectFiles,
          runtime: { filesystem: metered.filesystem },
          dispose: async () => projectFiles.dispose(),
        };
      },
    };

    const controller = new AbortController();
    const attempt = createWorkspaceWithFiles({ "index.ts": "1" }, META, deps, {
      into: id,
      signal: controller.signal,
    }).catch((error: unknown) => error);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(openCount).toBe(0);

    controller.abort(new Error("retry cancelled"));
    const outcome = await attempt;
    expect(outcome).toBeInstanceOf(Error);
    expect(openCount).toBe(0);

    lockGate.resolve();
    await holder;
    const metaBytes = metered.files.get(WORKSPACE_META_PATH);
    expect(parseMeta(metaBytes && new TextDecoder().decode(metaBytes))?.state).toBe(INCOMPLETE);
  });

  test("concurrent retries serialize under the metadata lock so only the first succeeds and files never mix", async () => {
    const id = "concretry";
    const metered = meteredProjectFilesystem({
      [WORKSPACE_META_PATH]: serializeMeta({ ...META, state: INCOMPLETE }),
      [`${PROJECT_ROOT}/stale.txt`]: "old",
    });
    const writeGate = Promise.withResolvers<void>();
    const firstWriting = Promise.withResolvers<void>();
    const projectFiles = createProjectFiles(metered.filesystem, () => () => {});
    let opens = 0;
    const writeWithGate = async (
      attemptNumber: number,
      entries: Readonly<Record<string, string | Uint8Array>>,
    ) => {
      if (attemptNumber === 1) {
        firstWriting.resolve();
        await writeGate.promise;
      }
      await projectFiles.writeMany(entries);
    };
    const deps: NewWorkspaceDeps = {
      exists: async () => true,
      remove: async () => "deleted",
      open: async () => {
        opens += 1;
        const attemptNumber = opens;
        return {
          files: { writeMany: (entries) => writeWithGate(attemptNumber, entries) },
          runtime: { filesystem: metered.filesystem },
          dispose: async () => undefined,
        };
      },
    };

    const first = createWorkspaceWithFiles({ "first.ts": "1\n" }, META, deps, { into: id });
    await firstWriting.promise;
    const second = createWorkspaceWithFiles({ "second.ts": "2\n" }, META, deps, { into: id }).catch(
      (error: unknown) => error,
    );

    writeGate.resolve();
    expect(await first).toBe(id);
    expect(await second).toBeInstanceOf(NotIncompleteError);
    expect(metered.files.has(`${PROJECT_ROOT}/first.ts`)).toBe(true);
    expect(metered.files.has(`${PROJECT_ROOT}/second.ts`)).toBe(false);
    expect(metered.files.has(`${PROJECT_ROOT}/stale.txt`)).toBe(false);
    projectFiles.dispose();
  });
});
