import { describe, expect, test } from "bun:test";
import { INCOMPLETE, parseMeta, serializeMeta, WORKSPACE_META_PATH } from "../importer/metadata";
import type { NewWorkspaceDeps, WorkspaceWriter } from "../importer/new-workspace";
import { PROJECT_ROOT, storageName } from "../workspace/paths";
import {
  renameWorkspace,
  retrySeedWorkspace,
  RetrySourceMismatchError,
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
            const prefix = `${path}/`;
            for (const key of Array.from(entry.files.keys())) {
              if (key === path || key.startsWith(prefix)) entry.files.delete(key);
            }
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
      newId: () => ids[index++] ?? ids[ids.length - 1] ?? `id${index}`,
      createNew: async (id, signal) => {
        signal?.throwIfAborted();
        openCalls.push({ id, requireExisting: false });
        const name = storageName(id);
        if (stores.has(name)) return "taken";
        const entry: FakeEntry = { files: new Map(), locked: true };
        stores.set(name, entry);
        return makeWriter(id, entry);
      },
      openExisting: async (id, signal) => {
        signal?.throwIfAborted();
        openCalls.push({ id, requireExisting: true });
        const entry = stores.get(storageName(id));
        if (!entry) return "missing";
        if (entry.locked) return "busy";
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
        if (!entry) return "missing";
        if (entry.locked) return "busy";
        entry.locked = true;
        return makeWriter(id, entry);
      },
    };
  }

  return {
    stores,
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
  });

  test("never overwrites a raced existing workspace and leaves the incomplete marker on failure without deleting", async () => {
    const env = createFakeEnv();
    env.stores.set(storageName("raced11111"), {
      files: new Map(),
      locked: false,
    });
    await expect(seedWorkspace("hono", {}, env.seedDeps(["raced11111"]))).rejects.toBeInstanceOf(
      WorkspaceIdTakenError,
    );
    expect(env.stores.get(storageName("raced11111"))?.files.size).toBe(0);

    env.setFailWriteMany(new Error("quota exceeded"));
    await expect(seedWorkspace("hono", {}, env.seedDeps(["fresh99999"]))).rejects.toThrow("quota exceeded");
    expect(env.stores.has(storageName("fresh99999"))).toBe(true);
    expect(parseMeta(env.stores.get(storageName("fresh99999"))?.files.get(WORKSPACE_META_PATH))?.state).toBe(
      INCOMPLETE,
    );
    expect(env.stores.get(storageName("fresh99999"))?.locked).toBe(false);
    expect(env.stores.has(storageName("raced11111"))).toBe(true);
  });

  test("retrySeedWorkspace finishes a matching incomplete template and refuses finished, busy, missing, or mismatched ones", async () => {
    const env = createFakeEnv();
    const partial = createWorkspaceMeta({ name: "my-hono", template: "hono", state: INCOMPLETE });
    env.stores.set(storageName("part111111"), {
      files: new Map([
        [WORKSPACE_META_PATH, serializeMeta(partial)],
        [`${PROJECT_ROOT}/stale.txt`, "old"],
      ]),
      locked: true,
    });

    // Busy while open in another tab: refuses without clearing stale files.
    expect(await retrySeedWorkspace("part111111", "hono", "my-hono", env.seedDeps())).toEqual({
      status: "busy",
    });
    expect(env.stores.get(storageName("part111111"))?.files.get(`${PROJECT_ROOT}/stale.txt`)).toBe("old");

    // Missing workspace: refuses without recreating it.
    expect(await retrySeedWorkspace("gone111111", "hono", "my-hono", env.seedDeps())).toEqual({
      status: "missing",
    });
    expect(env.stores.has(storageName("gone111111"))).toBe(false);

    // Unlock and verify mismatched template / unknown template are refused.
    env.stores.get(storageName("part111111"))!.locked = false;
    await expect(
      retrySeedWorkspace("part111111", "vite-react", "my-hono", env.seedDeps()),
    ).rejects.toBeInstanceOf(RetrySourceMismatchError);
    await expect(
      retrySeedWorkspace("part111111", "unknown-template", "my-hono", env.seedDeps()),
    ).rejects.toBeInstanceOf(RetrySourceMismatchError);
    expect(env.stores.get(storageName("part111111"))?.files.get(`${PROJECT_ROOT}/stale.txt`)).toBe("old");
    expect(env.stores.get(storageName("part111111"))?.locked).toBe(false);

    // Matching template completes and clears stale files.
    const retried = await retrySeedWorkspace("part111111", "hono", "my-hono", env.seedDeps());
    expect(retried.status).toBe("seeded");
    expect(env.stores.get(storageName("part111111"))?.files.get(`${PROJECT_ROOT}/stale.txt`)).toBeUndefined();
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

  test("seedWorkspace and retrySeedWorkspace preserve defaultName for unnamed blank workspaces", async () => {
    const env = createFakeEnv();
    const seeded = await seedWorkspace("blank", {}, env.seedDeps(["blank11111"]));
    expect(seeded.meta.defaultName).toBe(true);

    const partial = createWorkspaceMeta({
      name: "workspace",
      template: "blank",
      defaultName: true,
      state: INCOMPLETE,
    });
    env.stores.set(storageName("blank22222"), {
      files: new Map([[WORKSPACE_META_PATH, serializeMeta(partial)]]),
      locked: false,
    });
    const retried = await retrySeedWorkspace("blank22222", "blank", undefined, env.seedDeps());
    expect(retried.status).toBe("seeded");
    if (retried.status === "seeded") {
      expect(retried.meta.name).toBe("workspace");
      expect(retried.meta.defaultName).toBe(true);
    }
    expect(
      parseWorkspaceMeta(env.stores.get(storageName("blank22222"))?.files.get(WORKSPACE_META_PATH) ?? "")
        ?.defaultName,
    ).toBe(true);
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
