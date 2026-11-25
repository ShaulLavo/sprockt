import { expect, test } from "bun:test";
import { ProjectPathError } from "../workspace/paths";
import { createProjectFiles, type ProjectFilesystem, type ResolvedEntry } from "./project-files";

/** An in-memory filesystem: files, directories and symbolic links by absolute path. */
function memoryFilesystem(links: Readonly<Record<string, string>> = {}) {
  const files = new Map<string, Uint8Array>();
  const directories = new Set<string>(["/workspace"]);
  const flushes: PromiseWithResolvers<void>[] = [];
  const encoder = new TextEncoder();
  const filesystem: ProjectFilesystem = {
    async mkdirp(path) {
      const parts = path.split("/").slice(1);
      for (const [index] of parts.entries()) directories.add(`/${parts.slice(0, index + 1).join("/")}`);
    },
    async writeFile(path, content) {
      files.set(path, typeof content === "string" ? encoder.encode(content) : content);
    },
    readFile: async (path) => files.get(path),
    listFiles: async (path) => Array.from(files.keys()).filter((file) => file.startsWith(`${path}/`)),
    remove: async (path) => files.delete(path),
    async move(from, to) {
      const content = files.get(from);
      if (content) files.set(to, content);
      files.delete(from);
    },
    flush() {
      const next = Promise.withResolvers<void>();
      flushes.push(next);
      return next.promise;
    },
    async resolvePath(path): Promise<ResolvedEntry | undefined> {
      const target = links[path];
      if (target !== undefined) return { path, kind: "symlink", target };
      if (files.has(path)) return { path, kind: "file" };
      return directories.has(path) ? { path, kind: "dir" } : undefined;
    },
  };
  const text = (path: string) => new TextDecoder().decode(files.get(path));
  const finishFlushes = async () => {
    for (const flush of flushes.splice(0)) flush.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { filesystem, files, text, flushes, finishFlushes };
}

const noWatch = () => () => {};

test("paths that are absolute or climb out of the project are refused and nothing is written", async () => {
  const memory = memoryFilesystem();
  const service = createProjectFiles(memory.filesystem, noWatch);
  const bad = ["../outside.txt", "/etc/passwd", "a/../../b", "a//b", "./a", "", "a\0b"];
  const attempts = bad.flatMap((path) => [
    service.write(path, "x"),
    service.read(path),
    service.remove(path),
  ]);
  const outcomes = await Promise.allSettled(attempts.concat([service.move("ok.txt", "../moved.txt")]));
  expect(outcomes).toHaveLength(22);
  for (const outcome of outcomes) {
    expect(outcome.status).toBe("rejected");
    expect(outcome.status === "rejected" && outcome.reason).toBeInstanceOf(ProjectPathError);
  }
  expect(memory.files.size).toBe(0);
});

test("a bulk write with one bad path writes none of its files", async () => {
  const memory = memoryFilesystem();
  const service = createProjectFiles(memory.filesystem, noWatch);
  const write = service.writeMany({ "src/ok.ts": "ok", "../../etc/evil": "evil" });
  await expect(write).rejects.toBeInstanceOf(ProjectPathError);
  expect(memory.files.size).toBe(0);
});

test("a link that leaves the project is not written or read through", async () => {
  const memory = memoryFilesystem({ "/workspace/out": "/home/guest", "/workspace/up": "../etc" });
  const service = createProjectFiles(memory.filesystem, noWatch);
  await expect(service.write("out/secret.txt", "x")).rejects.toBeInstanceOf(ProjectPathError);
  await expect(service.read("up/passwd")).rejects.toBeInstanceOf(ProjectPathError);
  await expect(service.writeMany({ "a.txt": "a", "out/b.txt": "b" })).rejects.toBeInstanceOf(
    ProjectPathError,
  );
  expect(memory.files.size).toBe(0);
});

test("a link that stays inside the project works, and a link itself can be removed", async () => {
  const memory = memoryFilesystem({ "/workspace/alias": "src", "/workspace/out": "/home/guest" });
  const service = createProjectFiles(memory.filesystem, noWatch);
  await service.write("alias/main.ts", "inside");
  expect(memory.text("/workspace/alias/main.ts")).toBe("inside");
  await expect(service.remove("out")).resolves.toBeUndefined();
});

test("a loop of links is refused instead of followed forever", async () => {
  const memory = memoryFilesystem({ "/workspace/a": "b", "/workspace/b": "a" });
  const service = createProjectFiles(memory.filesystem, noWatch);
  await expect(service.read("a/file")).rejects.toBeInstanceOf(ProjectPathError);
});

test("the state is `saving` from the start of a write until its flush finished", async () => {
  const memory = memoryFilesystem();
  const service = createProjectFiles(memory.filesystem, noWatch);
  expect(service.saveState()).toBe("saved");

  const writing = service.write("a.txt", "one");
  expect(service.saveState()).toBe("saving");
  await writing;
  expect(service.saveState()).toBe("saving");
  expect(memory.flushes).toHaveLength(1);

  await memory.finishFlushes();
  expect(service.saveState()).toBe("saved");
  await expect(service.saved()).resolves.toBeUndefined();
});

test("a change outside the project (node_modules, a guest's home) still has to be flushed", async () => {
  const memory = memoryFilesystem();
  const watchers: ((names: readonly (string | null)[]) => void)[] = [];
  const service = createProjectFiles(memory.filesystem, (onChange) => {
    watchers.push(onChange);
    return () => {};
  });
  const before = service.revision();

  watchers[0]?.(["workspace/node_modules/react/index.js"]);
  expect(service.saveState()).toBe("saving");
  await memory.finishFlushes();
  expect(service.saveState()).toBe("saved");
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(service.revision()).toBe(before);
});

test("a write is skipped when the file changed since it was read", async () => {
  const memory = memoryFilesystem();
  const service = createProjectFiles(memory.filesystem, noWatch);
  await service.write("a.txt", "from the shell");

  expect(await service.writeIfUnchanged("a.txt", "mine", "what I read")).toEqual({
    written: false,
    current: "from the shell",
  });
  expect(memory.text("/workspace/a.txt")).toBe("from the shell");

  expect(await service.writeIfUnchanged("a.txt", "mine", "from the shell")).toEqual({ written: true });
  expect(memory.text("/workspace/a.txt")).toBe("mine");
  expect(await service.writeIfUnchanged("new.txt", "fresh", undefined)).toEqual({ written: true });
});

test("after the workspace moved to another tab every write is refused", async () => {
  const memory = memoryFilesystem();
  const service = createProjectFiles(memory.filesystem, noWatch);
  service.revoke(new Error("This workspace is open in another tab"));

  expect(service.writable()).toBe(false);
  expect(service.saveState()).toBe("failed");
  await expect(service.write("a.txt", "late")).rejects.toThrow("another tab");
  await expect(service.saved()).rejects.toThrow("another tab");
  expect(memory.files.size).toBe(0);
});
