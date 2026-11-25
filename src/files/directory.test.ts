import { expect, test } from "bun:test";
import { inflateRawSync } from "node:zlib";
import { ProjectPathError } from "../workspace/paths";
import {
  createProjectFiles,
  type LookedUpEntry,
  type ProjectFilesystem,
  type ResolvedEntry,
} from "./project-files";
import { DestinationExistsError, MoveIntoItselfError } from "./errors";
import type { FileChange } from "./service";

/** An in-memory filesystem with real directories, enough for listings, uploads and exports. */
function memoryFilesystem() {
  const files = new Map<string, Uint8Array>();
  const directories = new Set<string>(["/workspace"]);
  const encoder = new TextEncoder();
  const childrenOf = (path: string) => {
    const children = new Map<string, { kind: "file" | "dir" }>();
    for (const file of files.keys()) {
      if (!file.startsWith(`${path}/`)) continue;
      const [name = "", ...rest] = file.slice(path.length + 1).split("/");
      children.set(name, { kind: rest.length > 0 ? "dir" : "file" });
    }
    for (const directory of directories) {
      if (!directory.startsWith(`${path}/`)) continue;
      const [name = ""] = directory.slice(path.length + 1).split("/");
      children.set(name, { kind: "dir" });
    }
    return children;
  };
  const filesystem: ProjectFilesystem = {
    async mkdirp(path) {
      const parts = path.split("/").slice(1);
      for (const [index] of parts.entries()) directories.add(`/${parts.slice(0, index + 1).join("/")}`);
    },
    async writeFile(path, content, mode) {
      if (mode?.exclusive && (files.has(path) || directories.has(path))) throw new Error("EEXIST");
      files.set(path, typeof content === "string" ? encoder.encode(content) : content);
    },
    readFile: async (path) => files.get(path),
    listFiles: async (path) => Array.from(files.keys()).filter((file) => file.startsWith(`${path}/`)),
    async remove(path) {
      const doomed = Array.from(files.keys()).filter((file) => file === path || file.startsWith(`${path}/`));
      for (const file of doomed) files.delete(file);
      for (const directory of Array.from(directories)) {
        if (directory === path || directory.startsWith(`${path}/`)) directories.delete(directory);
      }
      return doomed.length > 0;
    },
    // Like Waffle's rename: the destination is replaced, and moving into itself fails.
    async move(from, to) {
      if (to.startsWith(`${from}/`)) throw new Error("EINVAL");
      for (const file of Array.from(files.keys())) {
        if (file !== from && !file.startsWith(`${from}/`)) continue;
        files.set(to + file.slice(from.length), files.get(file) ?? new Uint8Array());
        files.delete(file);
      }
      for (const directory of Array.from(directories)) {
        if (directory !== from && !directory.startsWith(`${from}/`)) continue;
        directories.add(to + directory.slice(from.length));
        directories.delete(directory);
      }
    },
    flush: async () => {},
    // Like Waffle's: a missing directory on the way is an ENOENT error, not undefined.
    async resolvePath(path): Promise<ResolvedEntry | undefined> {
      const parent = path.slice(0, path.lastIndexOf("/"));
      if (parent !== "" && !directories.has(parent)) {
        throw Object.assign(new Error("filesystem errno 44"), { errno: 44 });
      }
      if (files.has(path)) return { path, kind: "file" };
      return directories.has(path) ? { path, kind: "dir" } : undefined;
    },
    async lookup(path): Promise<LookedUpEntry | undefined> {
      if (files.has(path)) return { kind: "file" };
      const children = childrenOf(path);
      return directories.has(path) || children.size > 0 ? { kind: "dir", children } : undefined;
    },
  };
  return { filesystem, files, directories };
}

/** The service, plus the way to feed it watcher events like the ones the shell causes. */
function setup() {
  const memory = memoryFilesystem();
  const watcher = { emit: (_names: readonly (string | null)[]) => {} };
  const service = createProjectFiles(memory.filesystem, (onChange) => {
    watcher.emit = onChange;
    return () => {};
  });
  const next = () => new Promise<FileChange>((resolve) => service.subscribe(resolve));
  return { ...memory, service, emit: (...names: (string | null)[]) => watcher.emit(names), next };
}

const text = (files: Map<string, Uint8Array>, path: string) => new TextDecoder().decode(files.get(path));

test("a directory lists folders first, including empty ones, and hides Sprockt's own directory", async () => {
  const { service } = setup();
  await service.writeMany({
    "b.txt": "b",
    "a.txt": "a",
    "src/main.ts": "m",
  });
  await service.mkdir("empty");
  expect(await service.readdir("")).toEqual([
    { name: "empty", kind: "directory" },
    { name: "src", kind: "directory" },
    { name: "a.txt", kind: "file" },
    { name: "b.txt", kind: "file" },
  ]);
  expect(await service.readdir("src")).toEqual([{ name: "main.ts", kind: "file" }]);
  expect(await service.readdir("empty")).toEqual([]);
});

test("listing something that is missing, or is a file, gives undefined; a path outside the project is refused", async () => {
  const { service } = setup();
  await service.write("a.txt", "a");
  expect(await service.readdir("nope")).toBeUndefined();
  expect(await service.readdir("a.txt")).toBeUndefined();
  await expect(service.readdir("../etc")).rejects.toBeInstanceOf(ProjectPathError);
});

test("node_modules and .git are listed as folders but stay out of the flat file list", async () => {
  const { service } = setup();
  await service.writeMany({
    "node_modules/x/index.js": "x",
    ".git/HEAD": "ref",
    "a.txt": "a",
  });
  const names = (await service.readdir(""))?.map((entry) => entry.name);
  expect(names).toEqual([".git", "node_modules", "a.txt"]);
  expect(await service.list()).toEqual(["a.txt"]);
});

test("an upload writes files and folders under the directory, replacing files that exist", async () => {
  const { service, files } = setup();
  await service.write("docs/a.txt", "old");
  const result = await service.upload(
    [
      { path: "a.txt", data: new Blob(["new"]) },
      { path: "pics/logo.svg", data: new Blob(["<svg/>"]) },
      { path: "empty-folder" },
    ],
    "docs",
  );
  expect(result.skipped).toBe(0);
  expect(result.written.toSorted()).toEqual(["docs/a.txt", "docs/empty-folder", "docs/pics/logo.svg"]);
  expect(text(files, "/workspace/docs/a.txt")).toBe("new");
  expect(text(files, "/workspace/docs/pics/logo.svg")).toBe("<svg/>");
  expect((await service.readdir("docs/empty-folder"))?.length).toBe(0);
});

test("an upload leaves out unsafe paths and anything inside node_modules or .git", async () => {
  const { service, files } = setup();
  const blob = new Blob(["x"]);
  const result = await service.upload(
    [
      { path: "../escape.txt", data: blob },
      { path: "/etc/absolute.txt", data: blob },
      { path: "a//b.txt", data: blob },
      { path: "a\\b.txt", data: blob },
      { path: "site/node_modules/dep/i.js", data: blob },
      { path: ".git/HEAD", data: blob },
      { path: "ok.txt", data: blob },
    ],
    "",
  );
  expect(result.skipped).toBe(6);
  expect(result.written).toEqual(["ok.txt"]);
  expect(Array.from(files.keys())).toEqual(["/workspace/ok.txt"]);
});

test("an upload into a directory outside the project is refused and writes nothing", async () => {
  const { service, files } = setup();
  await expect(
    service.upload([{ path: "a.txt", data: new Blob(["x"]) }], "../outside"),
  ).rejects.toBeInstanceOf(ProjectPathError);
  expect(files.size).toBe(0);
});

test("subscribers hear which paths changed, once per burst, and moves say where files went", async () => {
  const { service, next } = setup();
  const burst = next();
  await service.write("src/a.ts", "a");
  await service.mkdir("docs");
  expect(await burst).toEqual({ paths: ["src/a.ts", "docs"], reset: false, moves: [], removed: [] });

  const moved = next();
  await service.move("src/a.ts", "src/b.ts");
  expect(await moved).toEqual({
    paths: ["src/a.ts", "src/b.ts"],
    reset: false,
    moves: [{ from: "src/a.ts", to: "src/b.ts" }],
    removed: [],
  });

  const removed = next();
  await service.remove("src/b.ts");
  expect(await removed).toEqual({ paths: ["src/b.ts"], reset: false, moves: [], removed: ["src/b.ts"] });
});

test("moving a folder reports the folder and every file inside it, at any depth", async () => {
  const { service, next } = setup();
  await service.writeMany({ "app/a.ts": "a", "app/deep/er/b.ts": "b", "other.txt": "o" });
  const moved = next();
  await service.move("app", "lib/renamed");
  const change = await moved;
  expect(change.moves.toSorted((a, b) => (a.from < b.from ? -1 : 1))).toEqual([
    { from: "app", to: "lib/renamed" },
    { from: "app/a.ts", to: "lib/renamed/a.ts" },
    { from: "app/deep/er/b.ts", to: "lib/renamed/deep/er/b.ts" },
  ]);
  expect((await service.list()).toSorted()).toEqual([
    "lib/renamed/a.ts",
    "lib/renamed/deep/er/b.ts",
    "other.txt",
  ]);
});

test("deleting a folder reports the folder and every file that was inside it", async () => {
  const { service, next } = setup();
  await service.writeMany({ "app/a.ts": "a", "app/deep/b.ts": "b", "keep.txt": "k" });
  const removed = next();
  await service.remove("app");
  expect((await removed).removed.toSorted()).toEqual(["app", "app/a.ts", "app/deep/b.ts"]);
});

test("create never replaces: a name taken by a file or a folder is refused and its bytes are kept", async () => {
  const { service, files } = setup();
  await service.write("a.txt", "precious");
  await service.mkdir("dir");
  await expect(service.create("a.txt")).rejects.toBeInstanceOf(DestinationExistsError);
  await expect(service.create("dir")).rejects.toBeInstanceOf(DestinationExistsError);
  expect(text(files, "/workspace/a.txt")).toBe("precious");
  await service.create("new/b.txt", "fresh");
  expect(text(files, "/workspace/new/b.txt")).toBe("fresh");
});

test("a move onto an existing name is refused and both sides are untouched", async () => {
  const { service, files } = setup();
  await service.writeMany({ "from.txt": "source", "to.txt": "target", "dir/x.txt": "x" });
  await expect(service.move("from.txt", "to.txt")).rejects.toBeInstanceOf(DestinationExistsError);
  await expect(service.move("from.txt", "dir")).rejects.toBeInstanceOf(DestinationExistsError);
  expect(text(files, "/workspace/from.txt")).toBe("source");
  expect(text(files, "/workspace/to.txt")).toBe("target");
});

test("a folder cannot move into itself, and the refusal creates no directories", async () => {
  const { service, directories } = setup();
  await service.write("app/a.ts", "a");
  const before = Array.from(directories);
  await expect(service.move("app", "app/inner/deeper")).rejects.toBeInstanceOf(MoveIntoItselfError);
  await expect(service.move("app", "app")).rejects.toBeInstanceOf(MoveIntoItselfError);
  expect(Array.from(directories)).toEqual(before);
});

test("moving something that does not exist is refused before any directory is made", async () => {
  const { service, directories } = setup();
  const before = Array.from(directories);
  await expect(service.move("ghost.txt", "new/place/ghost.txt")).rejects.toThrow("does not exist");
  expect(Array.from(directories)).toEqual(before);
});

test("watcher events become project paths, and churn in node_modules and .git is ignored", async () => {
  const { service, emit, next } = setup();
  const change = next();
  emit("workspace/node_modules/dep/index.js", "workspace/.git/index", "bin/bun");
  emit("workspace/src/from-shell.ts", "workspace/node_modules");
  expect(await change).toEqual({
    paths: ["src/from-shell.ts", "node_modules"],
    reset: false,
    moves: [],
    removed: [],
  });
  expect(service.revision()).toBeGreaterThan(0);
});

test("a watcher that lost events, or cannot name a change, makes subscribers list everything again", async () => {
  const { emit, next } = setup();
  const change = next();
  emit("workspace/a.ts");
  emit(null);
  expect(await change).toEqual({ paths: [], reset: true, moves: [], removed: [] });
});

/** The files of a ZIP, by name, read from its central directory. */
function unzip(bytes: Uint8Array): Map<string, string> {
  const archive = Buffer.from(bytes);
  const files = new Map<string, string>();
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let offset = archive.readUInt32LE(end + 16);
  for (let index = 0; index < archive.readUInt16LE(end + 10); index += 1) {
    const method = archive.readUInt16LE(offset + 10);
    const compressed = archive.readUInt32LE(offset + 20);
    const nameLength = archive.readUInt16LE(offset + 28);
    const trailer = archive.readUInt16LE(offset + 30) + archive.readUInt16LE(offset + 32);
    const local = archive.readUInt32LE(offset + 42);
    const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    const data = archive.subarray(start, start + compressed);
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    files.set(name, (method === 8 ? inflateRawSync(data) : data).toString("utf8"));
    offset += 46 + nameLength + trailer;
  }
  return files;
}

test("the ZIP holds the project's files and nothing from node_modules or .git", async () => {
  const { service } = setup();
  await service.writeMany({
    "package.json": '{"name":"x"}',
    "src/main.ts": "export const answer = 42;\n".repeat(20),
    "node_modules/dep/index.js": "dep",
    ".git/HEAD": "ref",
  });
  const archive = await (await service.exportZip()).arrayBuffer();
  const files = unzip(new Uint8Array(archive));
  expect(Array.from(files.keys())).toEqual(["package.json", "src/main.ts"]);
  expect(files.get("package.json")).toBe('{"name":"x"}');
  expect(files.get("src/main.ts")).toBe("export const answer = 42;\n".repeat(20));
});

/**
 * A filesystem whose flush behaves like Waffle's: the first failed change is kept in one slot and
 * thrown again, once, by the next flush. `race` names a path that looks free to the first check
 * but is taken by the time of the write.
 */
function flakyFilesystem(race?: string) {
  const memory = memoryFilesystem();
  const slot: { error?: Error } = {};
  const looks = new Map<string, number>();
  const filesystem: ProjectFilesystem = {
    ...memory.filesystem,
    async writeFile(path, content, mode) {
      try {
        if (path.endsWith("/bad.txt")) throw new Error("disk exploded");
        await memory.filesystem.writeFile(path, content, mode);
      } catch (error) {
        slot.error ??= error as Error;
        throw error;
      }
    },
    async flush() {
      const error = slot.error;
      slot.error = undefined;
      if (error) throw error;
    },
    // The look just before the write finds nothing: the file arrives right after it.
    async resolvePath(path) {
      const count = (looks.get(path) ?? 0) + 1;
      looks.set(path, count);
      if (path === race && count === 2) return undefined;
      return memory.filesystem.resolvePath(path);
    },
  };
  const service = createProjectFiles(filesystem, () => () => {});
  return { service, files: memory.files, filesystem };
}

test("a create that loses a race is answered once and does not fail the next save", async () => {
  const { service, files } = flakyFilesystem("/workspace/race.txt");
  files.set("/workspace/race.txt", new TextEncoder().encode("theirs"));
  await expect(service.create("race.txt")).rejects.toBeInstanceOf(DestinationExistsError);
  expect(text(files, "/workspace/race.txt")).toBe("theirs");
  await service.write("next.txt", "fine");
  await service.saved();
  expect(service.saveState()).toBe("saved");
});

test("a failed write nobody here made is not hidden by a refused create: the save state says failed", async () => {
  const { service, files, filesystem } = flakyFilesystem("/workspace/race.txt");
  files.set("/workspace/race.txt", new TextEncoder().encode("theirs"));
  // Someone else on the same Waffle queue (a program, another pane) fails a write first and takes
  // the single failure slot; this service never saw that error.
  await expect(filesystem.writeFile("/workspace/bad.txt", "x")).rejects.toThrow("disk exploded");
  await expect(service.create("race.txt")).rejects.toBeInstanceOf(DestinationExistsError);
  // The next flush throws the unrelated error. It cannot be matched to an operation of ours, so it
  // is not retried away.
  await service.write("next.txt", "x").catch(() => {});
  await expect(service.saved()).rejects.toThrow("disk exploded");
  expect(service.saveState()).toBe("failed");
});

test("writing, creating and uploading below folders that do not exist yet makes the folders", async () => {
  const { service, files } = setup();
  await service.write("a/b/c.txt", "written");
  await service.writeMany({ "d/e/f.txt": "many" });
  await service.create("g/h/i.txt", "created");
  await service.upload([{ path: "j/k/l.txt", data: new Blob(["uploaded"]) }], "m/n");
  expect(text(files, "/workspace/a/b/c.txt")).toBe("written");
  expect(text(files, "/workspace/d/e/f.txt")).toBe("many");
  expect(text(files, "/workspace/g/h/i.txt")).toBe("created");
  expect(text(files, "/workspace/m/n/j/k/l.txt")).toBe("uploaded");
});
