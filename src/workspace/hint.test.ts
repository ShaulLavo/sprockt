import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createEffect, createRoot } from "../lib/reactive";
import {
  createWorkspaceMeta,
  serializeWorkspaceMeta,
  updateWorkspaceMetaName,
} from "../templates/workspace-meta";
import {
  adoptUploadedWorkspaceName,
  handleHintStorageEvent,
  hydrateWorkspaceName,
  readWorkspaceHint,
  removeWorkspaceHint,
  saveWorkspaceHint,
  WORKSPACE_HINT_PREFIX,
  workspaceName,
} from "./hint";

function memoryStorage(options: { readonly failWrites?: boolean } = {}): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => Array.from(map.keys())[index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => {
      if (options.failWrites) throw new DOMException("QuotaExceededError", "QuotaExceededError");
      map.set(key, value);
    },
  };
}

const originalLocalStorage = globalThis.localStorage;

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: memoryStorage(),
  });
});

afterEach(() => {
  handleHintStorageEvent(null);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: originalLocalStorage,
  });
});

describe("workspace name hydration and reactivity", () => {
  test("hydrates an existing workspace from workspace.json and notifies reactive readers", async () => {
    const id = "yml15hftfs";
    const observed: string[] = [];
    const dispose = createRoot((stop) => {
      createEffect(() => {
        observed.push(workspaceName(id));
      });
      return stop;
    });
    expect(observed).toEqual([id]);

    const name = await hydrateWorkspaceName(id, {
      readMeta: async () =>
        JSON.stringify({
          name: "bash-web",
          created: "2026-11-26T00:00:00.000Z",
          source: { kind: "github", owner: "ShaulLavo", repo: "bash-web", ref: "main", subdir: "" },
        }),
      readPackageJson: async () => JSON.stringify({ name: "other-name" }),
    });

    dispose();
    expect(name).toBe("bash-web");
    expect(workspaceName(id)).toBe("bash-web");
    expect(observed).toEqual([id, "bash-web"]);
    expect(readWorkspaceHint(id)?.name).toBe("bash-web");
  });

  test("hydrates from root package.json when workspace.json is missing or marked defaultName", async () => {
    const id = "a0znor2ptn";
    let writtenMeta: string | undefined;

    const name = await hydrateWorkspaceName(id, {
      readMeta: async () => undefined,
      writeMeta: async (json) => void (writtenMeta = json),
      readPackageJson: async () => JSON.stringify({ name: "fregat-demo" }),
    });

    expect(name).toBe("fregat-demo");
    expect(workspaceName(id)).toBe("fregat-demo");
    expect(writtenMeta && JSON.parse(writtenMeta)).toMatchObject({ name: "fregat-demo" });
    expect(writtenMeta && JSON.parse(writtenMeta).defaultName).toBeUndefined();
  });

  test("preserves legacy pre-PR names on disk (even 'workspace' or 'Shared workspace') without overwriting", async () => {
    const legacyBlankId = "legacyblnk";
    const legacyBlankMeta = serializeWorkspaceMeta(
      createWorkspaceMeta({ name: "workspace", template: "blank" }),
    );
    let writes = 0;

    const blankResult = await hydrateWorkspaceName(legacyBlankId, {
      readMeta: async () => legacyBlankMeta,
      writeMeta: async () => void (writes += 1),
      readPackageJson: async () => JSON.stringify({ name: "should-not-overwrite" }),
    });

    expect(blankResult).toBe("workspace");
    expect(workspaceName(legacyBlankId)).toBe("workspace");
    expect(writes).toBe(0);

    const legacyShareId = "legacyshre";
    const legacyShareMeta = JSON.stringify({
      name: "Shared workspace",
      created: "2026-11-25T00:00:00.000Z",
      source: { kind: "share", template: "blank" },
    });
    const shareResult = await hydrateWorkspaceName(legacyShareId, {
      readMeta: async () => legacyShareMeta,
      writeMeta: async () => void (writes += 1),
      readPackageJson: async () => JSON.stringify({ name: "should-not-overwrite" }),
    });

    expect(shareResult).toBe("Shared workspace");
    expect(workspaceName(legacyShareId)).toBe("Shared workspace");
    expect(writes).toBe(0);
  });

  test("preserves an explicit user rename and clears defaultName", async () => {
    const id = "renamed123";
    const seeded = serializeWorkspaceMeta(
      createWorkspaceMeta({ name: "workspace", template: "blank", defaultName: true }),
    );
    const renamed = updateWorkspaceMetaName(seeded, "workspace");
    let writes = 0;

    const name = await hydrateWorkspaceName(id, {
      readMeta: async () => renamed.json,
      writeMeta: async () => void (writes += 1),
      readPackageJson: async () => JSON.stringify({ name: "pkg-name" }),
    });

    expect(name).toBe("workspace");
    expect(workspaceName(id)).toBe("workspace");
    expect(writes).toBe(0);
  });

  test("preserves an explicit user rename stored in hint even when workspace.json is missing", async () => {
    const id = "hintcustom";
    const meta = updateWorkspaceMetaName(undefined, "Pinned Name").meta;
    saveWorkspaceHint(id, meta);

    const name = await hydrateWorkspaceName(id, {
      readMeta: async () => undefined,
      readPackageJson: async () => JSON.stringify({ name: "pkg-name" }),
    });

    expect(name).toBe("Pinned Name");
    expect(workspaceName(id)).toBe("Pinned Name");
  });

  test("prefers in-memory fallback over stale localStorage on quota error and invalidates on storage event", () => {
    const id = "quotatest1";
    const oldMeta = createWorkspaceMeta({ name: "old-name", template: "blank" });
    const newMeta = createWorkspaceMeta({ name: "new-name", template: "blank" });
    saveWorkspaceHint(id, oldMeta);
    expect(workspaceName(id)).toBe("old-name");

    // Simulate a full localStorage where existing entries stay readable but setItem throws.
    const backing = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        get length() {
          return backing.length;
        },
        clear: () => backing.clear(),
        getItem: (key: string) => backing.getItem(key),
        key: (index: number) => backing.key(index),
        removeItem: (key: string) => backing.removeItem(key),
        setItem: () => {
          throw new DOMException("QuotaExceededError", "QuotaExceededError");
        },
      },
    });

    saveWorkspaceHint(id, newMeta);
    expect(workspaceName(id)).toBe("new-name");
    expect(readWorkspaceHint(id)?.name).toBe("new-name");

    // When another tab updates storage, the stale fallback entry is invalidated.
    const fromOtherTab = createWorkspaceMeta({ name: "other-tab-name", template: "blank" });
    backing.setItem(WORKSPACE_HINT_PREFIX + id, serializeWorkspaceMeta(fromOtherTab));
    handleHintStorageEvent(WORKSPACE_HINT_PREFIX + id);
    expect(workspaceName(id)).toBe("other-tab-name");
  });

  test("does not persist workspace.json while a workspace is still importing", async () => {
    const id = "importing1";
    let writes = 0;
    const incomplete = createWorkspaceMeta({
      name: "workspace",
      template: "blank",
      defaultName: true,
      state: "importing",
    });

    const name = await hydrateWorkspaceName(id, {
      readMeta: async () => serializeWorkspaceMeta(incomplete),
      writeMeta: async () => void (writes += 1),
      readPackageJson: async () => JSON.stringify({ name: "partial-pkg" }),
    });

    expect(name).toBe("partial-pkg");
    expect(writes).toBe(0);
  });

  test("adoptUploadedWorkspaceName derives from uploaded folder or root package.json without clobbering renames", async () => {
    const blankId = "blank12345";
    const blankMeta = serializeWorkspaceMeta(
      createWorkspaceMeta({ name: "workspace", template: "blank", defaultName: true }),
    );
    let savedJson: string | undefined;

    const adopted = await adoptUploadedWorkspaceName(
      blankId,
      [
        { path: "cool-folder/index.ts", data: new Blob(["export {}"]) },
        { path: "cool-folder/package.json", data: new Blob([JSON.stringify({ name: "ignored" })]) },
      ],
      {
        readMeta: async () => blankMeta,
        writeMeta: async (json) => void (savedJson = json),
        readPackageJson: async () => undefined,
      },
    );
    expect(adopted).toBe("cool-folder");
    expect(workspaceName(blankId)).toBe("cool-folder");
    expect(savedJson && JSON.parse(savedJson)).toMatchObject({ name: "cool-folder", template: "blank" });
    expect(savedJson && JSON.parse(savedJson).defaultName).toBeUndefined();

    // Uploading another folder later does not overwrite the adopted project name.
    const second = await adoptUploadedWorkspaceName(
      blankId,
      [{ path: "second-folder/a.txt", data: new Blob(["hi"]) }],
      {
        readMeta: async () => savedJson,
        readPackageJson: async () => undefined,
      },
    );
    expect(second).toBeUndefined();
    expect(workspaceName(blankId)).toBe("cool-folder");

    // Uploading loose root files including package.json derives from package.json.
    const looseId = "loose12345";
    const fromPkg = await adoptUploadedWorkspaceName(
      looseId,
      [
        { path: "index.ts", data: new Blob(["1"]) },
        { path: "package.json", data: new Blob([JSON.stringify({ name: "uploaded-pkg" })]) },
      ],
      {
        readMeta: async () => blankMeta,
        readPackageJson: async () => undefined,
      },
    );
    expect(fromPkg).toBe("uploaded-pkg");
    expect(workspaceName(looseId)).toBe("uploaded-pkg");

    removeWorkspaceHint(looseId);
    expect(workspaceName(looseId)).toBe(looseId);
  });

  test("never overwrites workspace.json or hint when readMeta fails transiently", async () => {
    const id = "readfail01";
    let writes = 0;

    const hydrated = await hydrateWorkspaceName(id, {
      readMeta: () => Promise.reject(new Error("transient IndexedDB error")),
      writeMeta: async () => void (writes += 1),
      readPackageJson: async () => JSON.stringify({ name: "should-not-write" }),
    });
    expect(hydrated).toBe(id);
    expect(writes).toBe(0);
    expect(readWorkspaceHint(id)).toBeUndefined();

    const adopted = await adoptUploadedWorkspaceName(
      id,
      [{ path: "uploaded-folder/index.ts", data: new Blob(["1"]) }],
      {
        readMeta: () => Promise.reject(new Error("transient IndexedDB error")),
        writeMeta: async () => void (writes += 1),
        readPackageJson: async () => JSON.stringify({ name: "should-not-write" }),
      },
    );
    expect(adopted).toBeUndefined();
    expect(writes).toBe(0);
    expect(readWorkspaceHint(id)).toBeUndefined();
  });

  test("serializes concurrent upload adoptions so the first writer wins and the second does not overwrite", async () => {
    const id = "concurrent1";
    let storedMeta: string | undefined = serializeWorkspaceMeta(
      createWorkspaceMeta({ name: "workspace", template: "blank", defaultName: true }),
    );
    const writes: string[] = [];
    const gate = Promise.withResolvers<void>();

    const deps = {
      readMeta: async () => storedMeta,
      writeMeta: async (json: string) => {
        writes.push(json);
        storedMeta = json;
      },
      readPackageJson: async () => undefined,
    };

    const slowBlob = {
      text: async () => {
        await gate.promise;
        return JSON.stringify({ name: "first-upload" });
      },
    } as Blob;

    const first = adoptUploadedWorkspaceName(id, [{ path: "package.json", data: slowBlob }], deps);
    const second = adoptUploadedWorkspaceName(
      id,
      [{ path: "second-folder/index.ts", data: new Blob(["2"]) }],
      deps,
    );

    gate.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toBe("first-upload");
    expect(secondResult).toBeUndefined();
    expect(writes).toHaveLength(1);
    expect(workspaceName(id)).toBe("first-upload");
  });

  test("preserves a saved name and valid fields in workspace.json even when timestamps are missing", async () => {
    const id = "notimestmp";
    const partialJson = JSON.stringify({
      name: "My Custom Workspace",
      template: "github",
      state: "importing",
      source: { kind: "github", owner: "acme", repo: "demo", ref: "main", subdir: "" },
    });
    let writes = 0;

    const hydrated = await hydrateWorkspaceName(id, {
      readMeta: async () => partialJson,
      writeMeta: async () => void (writes += 1),
      readPackageJson: async () => JSON.stringify({ name: "package-name" }),
    });
    expect(hydrated).toBe("My Custom Workspace");
    expect(workspaceName(id)).toBe("My Custom Workspace");
    expect(readWorkspaceHint(id)).toMatchObject({
      name: "My Custom Workspace",
      template: "github",
      state: "importing",
      source: { kind: "github", owner: "acme", repo: "demo", ref: "main", subdir: "" },
    });
    expect(writes).toBe(0);

    const adopted = await adoptUploadedWorkspaceName(
      id,
      [{ path: "uploaded-folder/index.ts", data: new Blob(["1"]) }],
      {
        readMeta: async () => partialJson,
        writeMeta: async () => void (writes += 1),
        readPackageJson: async () => JSON.stringify({ name: "package-name" }),
      },
    );
    expect(adopted).toBeUndefined();
    expect(workspaceName(id)).toBe("My Custom Workspace");
    expect(writes).toBe(0);
  });

  test("retries persisting an adopted folder name on reopen after a transient write failure", async () => {
    const id = "retrywrite1";
    let storedMeta: string | undefined = serializeWorkspaceMeta(
      createWorkspaceMeta({ name: "workspace", template: "blank", defaultName: true }),
    );
    let failWrites = true;
    const deps = {
      readMeta: async () => storedMeta,
      writeMeta: async (json: string) => {
        if (failWrites) throw new Error("transient write failure");
        storedMeta = json;
      },
      readPackageJson: async () => undefined,
    };

    const adopted = await adoptUploadedWorkspaceName(
      id,
      [{ path: "uploaded-app/index.ts", data: new Blob(["1"]) }],
      deps,
    );
    expect(adopted).toBe("uploaded-app");
    expect(workspaceName(id)).toBe("uploaded-app");
    // Disk still holds the placeholder because the write failed transiently.
    expect(JSON.parse(storedMeta!).defaultName).toBe(true);

    // Reopening after writes recover persists the adopted name to disk.
    failWrites = false;
    const hydrated = await hydrateWorkspaceName(id, deps);
    expect(hydrated).toBe("uploaded-app");
    expect(JSON.parse(storedMeta!)).toMatchObject({ name: "uploaded-app" });
    expect(JSON.parse(storedMeta!).defaultName).toBeUndefined();

    // Clearing the browser hint still recovers "uploaded-app" from disk.
    removeWorkspaceHint(id);
    const afterClear = await hydrateWorkspaceName(id, deps);
    expect(afterClear).toBe("uploaded-app");
    expect(workspaceName(id)).toBe("uploaded-app");
  });
});
