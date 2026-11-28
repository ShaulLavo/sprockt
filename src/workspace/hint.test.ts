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
  mergeStoredWorkspaceMeta,
  notifyWorkspaceWriterSettled,
  onWorkspaceWriterSettled,
  readWorkspaceHint,
  removeWorkspaceHint,
  saveWorkspaceHint,
  withoutWriterSettledNotifications,
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

function observeWorkspaceName(id: string): { readonly values: string[]; readonly dispose: () => void } {
  const values: string[] = [];
  const dispose = createRoot((stop) => {
    createEffect(() => void values.push(workspaceName(id)));
    return stop;
  });
  return { values, dispose };
}

describe("workspace name hydration and reactivity", () => {
  test("hydrates an existing workspace from workspace.json and notifies reactive readers", async () => {
    const id = "yml15hftfs";
    const { values: observed, dispose } = observeWorkspaceName(id);
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

    // Visiting the landing page while disk still holds the placeholder keeps the adopted hint.
    const diskMeta = createWorkspaceMeta({ name: "workspace", template: "blank", defaultName: true });
    const listed = mergeStoredWorkspaceMeta(id, diskMeta, readWorkspaceHint(id));
    expect(listed.name).toBe("uploaded-app");
    expect(listed.defaultName).toBeUndefined();
    saveWorkspaceHint(id, listed);
    expect(workspaceName(id)).toBe("uploaded-app");

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

  test("aborts a stalled lock wait cleanly when its signal cancels without mutating state", async () => {
    const id = "abortlock1";
    const gate = Promise.withResolvers<void>();
    const holder = hydrateWorkspaceName(id, {
      readMeta: async () => {
        await gate.promise;
        return undefined;
      },
      readPackageJson: async () => undefined,
    });

    const controller = new AbortController();
    let secondWrites = 0;
    const waiting = hydrateWorkspaceName(id, {
      readMeta: async () => undefined,
      writeMeta: async () => void (secondWrites += 1),
      readPackageJson: async () => JSON.stringify({ name: "cancelled-app" }),
      signal: controller.signal,
    });
    controller.abort();

    await expect(waiting).rejects.toThrow();
    expect(secondWrites).toBe(0);
    expect(readWorkspaceHint(id)).toBeUndefined();

    gate.resolve();
    await holder;
  });

  test("cancelling a queued waiter preserves serialization between the active holder and later callers", async () => {
    const id = "queueordr1";
    const order: string[] = [];
    const firstGate = Promise.withResolvers<void>();

    const first = hydrateWorkspaceName(id, {
      readMeta: async () => {
        order.push("first-start");
        await firstGate.promise;
        order.push("first-end");
        return undefined;
      },
      readPackageJson: async () => undefined,
    });

    const cancelSecond = new AbortController();
    const second = hydrateWorkspaceName(id, {
      readMeta: async () => {
        order.push("second");
        return undefined;
      },
      readPackageJson: async () => undefined,
      signal: cancelSecond.signal,
    });

    const third = hydrateWorkspaceName(id, {
      readMeta: async () => {
        order.push("third-start");
        return undefined;
      },
      readPackageJson: async () => undefined,
    });

    cancelSecond.abort();
    await expect(second).rejects.toThrow();
    await Promise.resolve();
    expect(order).toEqual(["first-start"]);

    firstGate.resolve();
    await Promise.all([first, third]);
    expect(order).toEqual(["first-start", "first-end", "third-start"]);
  });

  test("aborted upload adoption never overwrites an explicit rename in the browser hint", async () => {
    const id = "abortupld1";
    const blankMeta = serializeWorkspaceMeta(
      createWorkspaceMeta({ name: "workspace", template: "blank", defaultName: true }),
    );
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const sessionController = new AbortController();
    let writes = 0;

    const slowPkg = {
      text: async () => {
        started.resolve();
        await gate.promise;
        return JSON.stringify({ name: "uploaded-name" });
      },
    } as Blob;

    const pendingUpload = adoptUploadedWorkspaceName(id, [{ path: "package.json", data: slowPkg }], {
      readMeta: async () => blankMeta,
      writeMeta: async () => void (writes += 1),
      readPackageJson: async () => undefined,
      signal: sessionController.signal,
    });

    await started.promise;
    // User leaves the workspace (aborting session) and renames it on the landing page.
    sessionController.abort();
    saveWorkspaceHint(id, updateWorkspaceMetaName(blankMeta, "explicit-name").meta);
    gate.resolve();

    expect(await pendingUpload).toBeUndefined();
    expect(writes).toBe(0);
    expect(workspaceName(id)).toBe("explicit-name");
  });

  test("preserves an uploaded folder name across leave and reopen even when the naming lock was held", async () => {
    const id = "pendlock01";
    let storedMeta = serializeWorkspaceMeta(
      createWorkspaceMeta({ name: "workspace", template: "blank", defaultName: true }),
    );
    saveWorkspaceHint(id, createWorkspaceMeta({ name: "workspace", template: "blank", defaultName: true }));

    const lockGate = Promise.withResolvers<void>();
    const holder = hydrateWorkspaceName(id, {
      readMeta: async () => {
        await lockGate.promise;
        return storedMeta;
      },
      readPackageJson: async () => undefined,
    });

    const sessionController = new AbortController();
    const deps = {
      readMeta: async () => storedMeta,
      writeMeta: async (json: string) => void (storedMeta = json),
      readPackageJson: async () => undefined,
    };

    // Upload runs while another operation holds the naming lock, then user leaves immediately.
    const uploadAdoption = adoptUploadedWorkspaceName(
      id,
      [{ path: "named-folder/index.ts", data: new Blob(["1"]) }],
      { ...deps, signal: sessionController.signal },
    );
    sessionController.abort();
    await expect(uploadAdoption).rejects.toThrow();

    // Release the lock and reopen the workspace directly: the pending folder name is applied under the lock.
    lockGate.resolve();
    await holder;

    const reopened = await hydrateWorkspaceName(id, deps);
    expect(reopened).toBe("named-folder");
    expect(workspaceName(id)).toBe("named-folder");
    expect(JSON.parse(storedMeta)).toMatchObject({ name: "named-folder" });
    expect(JSON.parse(storedMeta).defaultName).toBeUndefined();
  });

  test("does not apply a pending uploaded folder name if the workspace was renamed or already named on disk", async () => {
    // Case 1: User leaves while lock is held and explicitly renames on landing page.
    const renamedId = "pendrenm01";
    const blankMeta = serializeWorkspaceMeta(
      createWorkspaceMeta({ name: "workspace", template: "blank", defaultName: true }),
    );
    const gate1 = Promise.withResolvers<void>();
    const holder1 = hydrateWorkspaceName(renamedId, {
      readMeta: async () => {
        await gate1.promise;
        return blankMeta;
      },
      readPackageJson: async () => undefined,
    });
    const controller1 = new AbortController();
    const upload1 = adoptUploadedWorkspaceName(
      renamedId,
      [{ path: "named-folder/index.ts", data: new Blob(["1"]) }],
      {
        readMeta: async () => blankMeta,
        readPackageJson: async () => undefined,
        signal: controller1.signal,
      },
    );
    controller1.abort();
    await expect(upload1).rejects.toThrow();
    const explicit = updateWorkspaceMetaName(blankMeta, "explicit-name");
    saveWorkspaceHint(renamedId, explicit.meta);
    gate1.resolve();
    await holder1;

    const afterRename = await hydrateWorkspaceName(renamedId, {
      readMeta: async () => explicit.json,
      readPackageJson: async () => undefined,
    });
    expect(afterRename).toBe("explicit-name");
    expect(workspaceName(renamedId)).toBe("explicit-name");

    // Case 2: Hint was missing while lock was held, but disk already had a real name.
    const diskNamedId = "penddisk01";
    const diskNamedJson = serializeWorkspaceMeta(
      createWorkspaceMeta({ name: "existing-project", template: "blank" }),
    );
    const gate2 = Promise.withResolvers<void>();
    const holder2 = hydrateWorkspaceName(diskNamedId, {
      readMeta: async () => {
        await gate2.promise;
        return diskNamedJson;
      },
      readPackageJson: async () => undefined,
    });
    const controller2 = new AbortController();
    const upload2 = adoptUploadedWorkspaceName(
      diskNamedId,
      [{ path: "named-folder/index.ts", data: new Blob(["1"]) }],
      {
        readMeta: async () => diskNamedJson,
        readPackageJson: async () => undefined,
        signal: controller2.signal,
      },
    );
    controller2.abort();
    await expect(upload2).rejects.toThrow();
    gate2.resolve();
    await holder2;

    expect(workspaceName(diskNamedId)).toBe("existing-project");
  });

  test("keeps pending folder name in localStorage when full hint hits quota and metadata write fails", async () => {
    const id = "quotapend1";
    let storedMeta = serializeWorkspaceMeta(
      createWorkspaceMeta({ name: "workspace", template: "blank", defaultName: true }),
    );
    saveWorkspaceHint(id, createWorkspaceMeta({ name: "workspace", template: "blank", defaultName: true }));

    // Simulate tight storage quota: accepts the short pending-name string, rejects the larger JSON hint.
    const originalSetItem = localStorage.setItem.bind(localStorage);
    let rejectLargeWrites = true;
    localStorage.setItem = (key: string, value: string) => {
      if (rejectLargeWrites && value.length > 40) throw new Error("QuotaExceededError");
      originalSetItem(key, value);
    };

    try {
      const adopted = await adoptUploadedWorkspaceName(
        id,
        [{ path: "tight-quota-folder/index.ts", data: new Blob(["1"]) }],
        {
          readMeta: async () => storedMeta,
          writeMeta: () => Promise.reject(new Error("transient write failure")),
          readPackageJson: async () => undefined,
        },
      );
      expect(adopted).toBe("tight-quota-folder");
      expect(workspaceName(id)).toBe("tight-quota-folder");

      // A second upload while only the in-memory hint exists must not wipe the pending name.
      const second = await adoptUploadedWorkspaceName(
        id,
        [{ path: "second-folder/other.ts", data: new Blob(["2"]) }],
        {
          readMeta: async () => storedMeta,
          writeMeta: () => Promise.reject(new Error("transient write failure")),
          readPackageJson: async () => undefined,
        },
      );
      expect(second).toBeUndefined();

      // Simulate a page reload dropping in-memory fallbackHints while localStorage keeps only what fit.
      handleHintStorageEvent(WORKSPACE_HINT_PREFIX + id);
      rejectLargeWrites = false;

      const reopened = await hydrateWorkspaceName(id, {
        readMeta: async () => storedMeta,
        writeMeta: async (json: string) => void (storedMeta = json),
        readPackageJson: async () => undefined,
      });
      expect(reopened).toBe("tight-quota-folder");
      expect(workspaceName(id)).toBe("tight-quota-folder");
      expect(JSON.parse(storedMeta)).toMatchObject({ name: "tight-quota-folder" });
    } finally {
      localStorage.setItem = originalSetItem;
    }
  });

  test("never overwrites GitHub import metadata (source, pendingImport) written concurrently during hydration", async () => {
    const id = "imprtrace1";
    let storedMeta: string | undefined;
    const pkgStarted = Promise.withResolvers<void>();
    const pkgResume = Promise.withResolvers<void>();

    const hydration = hydrateWorkspaceName(id, {
      readMeta: async () => storedMeta,
      writeMeta: async (json: string) => void (storedMeta = json),
      readPackageJson: async () => {
        pkgStarted.resolve();
        await pkgResume.promise;
        return JSON.stringify({ name: "pkg-derived-name" });
      },
    });

    await pkgStarted.promise;
    // Simulate a completed GitHub import landing while hydration was awaiting package.json.
    const importedMeta = {
      name: "demo-repo",
      template: "github",
      created: "2026-04-01T00:00:00.000Z",
      lastOpened: "2026-04-01T00:00:00.000Z",
      source: { kind: "github", owner: "acme", repo: "demo-repo", ref: "main", subdir: "" },
      pendingImport: { install: { program: "bun", args: ["install"] }, dev: undefined, port: undefined },
    };
    storedMeta = `${JSON.stringify(importedMeta, null, 2)}\n`;
    pkgResume.resolve();

    expect(await hydration).toBe("demo-repo");
    expect(workspaceName(id)).toBe("demo-repo");
    expect(JSON.parse(storedMeta)).toEqual(importedMeta);
  });

  test("preserves known hint details (template, created, source) when recovering missing workspace.json", async () => {
    const id = "recovgh01";
    const ghHint = {
      name: "demo-repo",
      template: "github",
      created: "2026-01-15T12:00:00.000Z",
      lastOpened: "2026-01-16T12:00:00.000Z",
      source: { kind: "github" as const, owner: "acme", repo: "demo-repo", ref: "main", subdir: "" },
    };
    saveWorkspaceHint(id, ghHint);

    let persisted: string | undefined;
    const hydrated = await hydrateWorkspaceName(id, {
      readMeta: async () => undefined,
      writeMeta: async (json: string) => void (persisted = json),
      readPackageJson: async () => undefined,
      now: () => new Date("2026-04-01T00:00:00.000Z"),
    });

    expect(hydrated).toBe("demo-repo");
    expect(readWorkspaceHint(id)).toEqual({
      ...ghHint,
      lastOpened: "2026-04-01T00:00:00.000Z",
    });
    expect(JSON.parse(persisted!)).toEqual({
      ...ghHint,
      lastOpened: "2026-04-01T00:00:00.000Z",
    });
  });
});

describe("workspace writer settled notifications", () => {
  test("suppresses notifications during foreground handoff tasks and restores them even on failure", async () => {
    let calls = 0;
    const unsubscribe = onWorkspaceWriterSettled(() => {
      calls += 1;
    });
    try {
      notifyWorkspaceWriterSettled();
      expect(calls).toBe(1);

      await withoutWriterSettledNotifications(async () => {
        notifyWorkspaceWriterSettled();
      });
      expect(calls).toBe(1);

      await expect(
        withoutWriterSettledNotifications(async () => {
          notifyWorkspaceWriterSettled();
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(calls).toBe(1);

      notifyWorkspaceWriterSettled();
      expect(calls).toBe(2);
    } finally {
      unsubscribe();
    }
    notifyWorkspaceWriterSettled();
    expect(calls).toBe(2);
  });
});
