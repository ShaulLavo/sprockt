import { describe, expect, test } from "bun:test";
import { INCOMPLETE, parseMeta, serializeMeta, WORKSPACE_META_PATH } from "../importer/metadata";
import type { NewWorkspaceDeps, WorkspaceWriter } from "../importer/new-workspace";
import { PROJECT_ROOT, storageName } from "../workspace/paths";
import {
  renameWorkspace,
  retrySeedWorkspace,
  seedWorkspace,
  WorkspaceIdTakenError,
  type OpenRenameOptions,
  type RenameWorkspaceDeps,
} from "./seed";
import { createWorkspaceMeta, parseWorkspaceMeta } from "./workspace-meta";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface FakeEntry {
  files: Map<string, string>;
  locked: boolean;
}

function createFakeEnv() {
  const stores = new Map<string, FakeEntry>();
  const removed: string[] = [];
  const openCalls: Array<{ readonly id: string; readonly requireExisting: boolean }> = [];
  let onWriteFile: ((id: string, path: string, content: string) => void) | undefined;
  let failWriteMany: Error | undefined;

  function makeWriter(id: string, entry: FakeEntry): WorkspaceWriter {
    return {
      files: {
        async writeMany(files) {
          if (failWriteMany) throw failWriteMany;
          for (const [rel, content] of Object.entries(files)) {
            const text = typeof content === "string" ? content : decoder.decode(content);
            const path = `${PROJECT_ROOT}/${rel}`;
            onWriteFile?.(id, path, text);
            entry.files.set(path, text);
          }
        },
      },
      runtime: {
        filesystem: {
          async listFiles(dir) {
            const prefix = dir === "/" ? "/" : `${dir}/`;
            return Array.from(entry.files.keys()).filter((path) => path.startsWith(prefix));
          },
          async mkdirp() {},
          async readFile(path) {
            const value = entry.files.get(path);
            return value === undefined ? undefined : encoder.encode(value);
          },
          async writeFile(path, content) {
            const text = typeof content === "string" ? content : decoder.decode(content);
            onWriteFile?.(id, path, text);
            entry.files.set(path, text);
          },
          async remove(path) {
            entry.files.delete(path);
          },
          async flush() {},
        },
      },
      async dispose() {
        entry.locked = false;
      },
    };
  }

  function seedDeps(ids: readonly string[] = []): NewWorkspaceDeps {
    let index = 0;
    return {
      newId: () => ids[index++] ?? `id${index}`,
      exists: async (name) => stores.has(name),
      remove: async (name) => {
        removed.push(name);
        return stores.delete(name) ? "deleted" : "missing";
      },
      open: async (id) => {
        openCalls.push({ id, requireExisting: false });
        const name = storageName(id);
        let entry = stores.get(name);
        if (!entry) {
          entry = { files: new Map(), locked: false };
          stores.set(name, entry);
        }
        if (entry.locked) throw new Error("busy");
        entry.locked = true;
        return makeWriter(id, entry);
      },
    };
  }

  function renameDeps(): RenameWorkspaceDeps {
    return {
      async open(id: string, options: OpenRenameOptions) {
        openCalls.push({ id, requireExisting: options.requireExisting });
        const entry = stores.get(storageName(id));
        if (!entry) return options.requireExisting ? "missing" : "missing";
        if (entry.locked) return "busy";
        entry.locked = true;
        return makeWriter(id, entry);
      },
    };
  }

  return {
    stores,
    removed,
    openCalls,
    seedDeps,
    renameDeps,
    setOnWriteFile(hook: ((id: string, path: string, content: string) => void) | undefined) {
      onWriteFile = hook;
    },
    setFailWriteMany(error: Error | undefined) {
      failWriteMany = error;
    },
  };
}

describe("seedWorkspace (via shared createWorkspaceWithFiles)", () => {
  test("picks a fresh unused id, writes incomplete marker first, then clears it on completion", async () => {
    const env = createFakeEnv();
    env.stores.set(storageName("taken11111"), {
      files: new Map([[`${PROJECT_ROOT}/keep.txt`, "precious"]]),
      locked: false,
    });

    const states: Array<string | undefined> = [];
    env.setOnWriteFile((_id, path, content) => {
      if (path === WORKSPACE_META_PATH) states.push(parseMeta(content)?.state);
    });

    const result = await seedWorkspace("bun-sqlite", {}, env.seedDeps(["taken11111", "fresh22222"]));
    expect(result.id).toBe("fresh22222");
    expect(states).toEqual([INCOMPLETE, undefined]);
    expect(env.stores.get(storageName("taken11111"))?.files.get(`${PROJECT_ROOT}/keep.txt`)).toBe("precious");
    expect(env.stores.get(storageName("fresh22222"))?.files.get(`${PROJECT_ROOT}/server.ts`)).toContain(
      "bun:sqlite",
    );
    expect(env.removed).toEqual([]);
  });

  test("never overwrites or deletes a raced existing workspace and rolls back only its own failed seed", async () => {
    const env = createFakeEnv();
    env.stores.set(storageName("raced11111"), {
      files: new Map([[`${PROJECT_ROOT}/existing.ts`, "keep"]]),
      locked: false,
    });
    const racedDeps: NewWorkspaceDeps = {
      ...env.seedDeps(["raced11111"]),
      exists: async () => false,
    };
    await expect(seedWorkspace("hono", {}, racedDeps)).rejects.toBeInstanceOf(WorkspaceIdTakenError);
    expect(env.stores.get(storageName("raced11111"))?.files.get(`${PROJECT_ROOT}/existing.ts`)).toBe("keep");
    expect(env.removed).toEqual([]);

    env.setFailWriteMany(new Error("quota exceeded"));
    await expect(seedWorkspace("hono", {}, env.seedDeps(["fresh99999"]))).rejects.toThrow("quota exceeded");
    expect(env.removed).toEqual([storageName("fresh99999")]);
    expect(env.stores.has(storageName("fresh99999"))).toBe(false);
    expect(env.stores.has(storageName("raced11111"))).toBe(true);
  });

  test("retrySeedWorkspace finishes an incomplete template workspace and refuses a finished one", async () => {
    const env = createFakeEnv();
    const partial = createWorkspaceMeta({ name: "my-hono", template: "hono", state: INCOMPLETE });
    env.stores.set(storageName("part111111"), {
      files: new Map([[WORKSPACE_META_PATH, serializeMeta(partial)]]),
      locked: false,
    });

    const retried = await retrySeedWorkspace("part111111", "hono", "my-hono", env.seedDeps());
    expect(retried.status).toBe("seeded");
    expect(env.stores.get(storageName("part111111"))?.files.get(`${PROJECT_ROOT}/server.ts`)).toContain(
      "Hono",
    );
    expect(
      parseMeta(env.stores.get(storageName("part111111"))?.files.get(WORKSPACE_META_PATH))?.state,
    ).toBeUndefined();

    // Retrying a completed workspace refuses without overwriting user edits.
    env.stores.get(storageName("part111111"))!.files.set(`${PROJECT_ROOT}/server.ts`, "user edit");
    const second = await retrySeedWorkspace("part111111", "hono", "my-hono", env.seedDeps());
    expect(second).toEqual({ status: "already-ready" });
    expect(env.stores.get(storageName("part111111"))?.files.get(`${PROJECT_ROOT}/server.ts`)).toBe(
      "user edit",
    );
  });
});

describe("renameWorkspace", () => {
  test("holds one single exclusive lock across read and write and returns busy if another tab owns it", async () => {
    const env = createFakeEnv();
    const meta = createWorkspaceMeta({ name: "old-name", template: "vite-react" });
    const entry: FakeEntry = {
      files: new Map([[WORKSPACE_META_PATH, serializeMeta(meta)]]),
      locked: true,
    };
    env.stores.set(storageName("busy111111"), entry);

    const busyResult = await renameWorkspace("busy111111", "new-name", env.renameDeps());
    expect(busyResult).toEqual({ status: "busy" });
    expect(entry.locked).toBe(true);
    expect(parseWorkspaceMeta(entry.files.get(WORKSPACE_META_PATH) ?? "")?.name).toBe("old-name");

    entry.locked = false;
    let lockHeldDuringWrite = false;
    env.setOnWriteFile((_id, path) => {
      if (path === WORKSPACE_META_PATH) lockHeldDuringWrite = entry.locked;
    });

    const renamed = await renameWorkspace("busy111111", "renamed-app", env.renameDeps());
    expect(renamed.status).toBe("renamed");
    expect(lockHeldDuringWrite).toBe(true);
    expect(entry.locked).toBe(false);
    expect(env.openCalls).toHaveLength(2);
    expect(env.openCalls[1]?.requireExisting).toBe(true);
    expect(parseWorkspaceMeta(entry.files.get(WORKSPACE_META_PATH) ?? "")?.name).toBe("renamed-app");
  });

  test("returns missing without recreating a deleted workspace", async () => {
    const env = createFakeEnv();
    const result = await renameWorkspace("gone111111", "ghost", env.renameDeps());
    expect(result).toEqual({ status: "missing" });
    expect(env.stores.has(storageName("gone111111"))).toBe(false);
  });
});
