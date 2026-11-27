import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createEffect, createRoot } from "../lib/reactive";
import {
  createWorkspaceMeta,
  serializeWorkspaceMeta,
  updateWorkspaceMetaName,
} from "../templates/workspace-meta";
import {
  adoptUploadedWorkspaceName,
  hydrateWorkspaceName,
  readWorkspaceHint,
  removeWorkspaceHint,
  saveWorkspaceHint,
  workspaceName,
} from "./hint";

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => Array.from(map.keys())[index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, value),
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

  test("hydrates from root package.json when workspace.json is missing or blank default", async () => {
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
    expect(writtenMeta && JSON.parse(writtenMeta).customName).toBeUndefined();
  });

  test("preserves an explicit user rename and never overwrites it with package.json", async () => {
    const id = "renamed123";
    const renamed = updateWorkspaceMetaName(
      serializeWorkspaceMeta(createWorkspaceMeta({ name: "workspace", template: "blank" })),
      "My Custom App",
    );
    let writes = 0;

    const name = await hydrateWorkspaceName(id, {
      readMeta: async () => renamed.json,
      writeMeta: async () => void (writes += 1),
      readPackageJson: async () => JSON.stringify({ name: "pkg-name" }),
    });

    expect(name).toBe("My Custom App");
    expect(workspaceName(id)).toBe("My Custom App");
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

  test("does not persist workspace.json while a workspace is still importing", async () => {
    const id = "importing1";
    let writes = 0;
    const incomplete = createWorkspaceMeta({ name: "workspace", template: "blank", state: "importing" });

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
    const blankMeta = serializeWorkspaceMeta(createWorkspaceMeta({ name: "workspace", template: "blank" }));
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
});
