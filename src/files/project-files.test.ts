import { expect, test } from "bun:test";
import { ProjectPathError } from "../workspace/paths";
import { createProjectFiles, type ProjectFilesystem, type ResolvedEntry } from "./project-files";

interface Setup {
  /** Symbolic links: absolute path of the link to its target, as written in the link. */
  readonly links?: Readonly<Record<string, string>>;
  /** Directories that exist besides the project root. */
  readonly directories?: readonly string[];
  /** Files that exist, by real absolute path. */
  readonly files?: Readonly<Record<string, string>>;
}

/**
 * An in-memory filesystem that resolves paths the way Waffle does: a link in the middle of a
 * path is followed, and `..` then climbs from where the link really led, not from where the
 * link was written. Every operation resolves its path again, as Waffle's operations do.
 */
function memoryFilesystem(setup: Setup = {}) {
  const links = setup.links ?? {};
  const encoder = new TextEncoder();
  const files = new Map<string, Uint8Array>(
    Object.entries(setup.files ?? {}).map(([path, text]) => [path, encoder.encode(text)]),
  );
  const directories = new Set(["/workspace"].concat(setup.directories ?? []));
  const flushes: PromiseWithResolvers<void>[] = [];

  function real(path: string, followLast: boolean, hops = 0): string {
    if (hops > 16) throw new Error("ELOOP: too many levels of symbolic links");
    const parts = path.split("/").filter(Boolean);
    const walked: string[] = [];
    for (const [index, name] of parts.entries()) {
      if (name === "..") walked.pop();
      if (name === ".." || name === ".") continue;
      const target = links[`/${walked.concat([name]).join("/")}`];
      if (target === undefined || (index === parts.length - 1 && !followLast)) {
        walked.push(name);
        continue;
      }
      const from = target.startsWith("/") ? target : `/${walked.join("/")}/${target}`;
      return real([from].concat(parts.slice(index + 1)).join("/"), followLast, hops + 1);
    }
    return `/${walked.join("/")}`;
  }

  const filesystem: ProjectFilesystem = {
    async mkdirp(path) {
      const parts = real(path, true).split("/").slice(1);
      for (const [index] of parts.entries()) directories.add(`/${parts.slice(0, index + 1).join("/")}`);
    },
    async writeFile(path, content) {
      files.set(real(path, true), typeof content === "string" ? encoder.encode(content) : content);
    },
    readFile: async (path) => files.get(real(path, true)),
    listFiles: async (path) => Array.from(files.keys()).filter((file) => file.startsWith(`${path}/`)),
    remove: async (path) => files.delete(real(path, false)),
    async move(from, to) {
      const content = files.get(real(from, false));
      if (content) files.set(real(to, false), content);
      files.delete(real(from, false));
    },
    flush() {
      const next = Promise.withResolvers<void>();
      flushes.push(next);
      return next.promise;
    },
    async resolvePath(path): Promise<ResolvedEntry | undefined> {
      const canonical = real(path, false);
      const target = links[canonical];
      if (target !== undefined) return { path: canonical, kind: "symlink", target };
      if (files.has(canonical)) return { path: canonical, kind: "file" };
      if (directories.has(canonical)) return { path: canonical, kind: "dir" };
      // As Waffle does: a missing last name is "no entry", a missing directory on the way is
      // an error.
      const parent = canonical.slice(0, canonical.lastIndexOf("/")) || "/";
      if (parent === "/" || directories.has(parent)) return undefined;
      throw Object.assign(new Error("filesystem errno 44"), { errno: 44 });
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

test("files are written into directories that do not exist yet", async () => {
  const memory = memoryFilesystem();
  const service = createProjectFiles(memory.filesystem, noWatch);
  await service.write("src/deep/er/main.ts", "nested");
  await service.writeMany({ "pkg/a/one.ts": "1", "pkg/b/two.ts": "2", "top.ts": "3" });
  await service.mkdir("empty/inside");
  expect(memory.text("/workspace/src/deep/er/main.ts")).toBe("nested");
  expect(memory.text("/workspace/pkg/b/two.ts")).toBe("2");
  expect(await service.read("not/there/at/all.ts")).toBeUndefined();
});

test("a bulk write with one bad path writes none of its files", async () => {
  const memory = memoryFilesystem();
  const service = createProjectFiles(memory.filesystem, noWatch);
  const write = service.writeMany({ "src/ok.ts": "ok", "../../etc/evil": "evil" });
  await expect(write).rejects.toBeInstanceOf(ProjectPathError);
  expect(memory.files.size).toBe(0);
});

test("a link that leaves the project is not written or read through", async () => {
  const memory = memoryFilesystem({
    links: { "/workspace/out": "/home/guest", "/workspace/up": "../etc" },
    directories: ["/home", "/home/guest", "/etc"],
    files: { "/home/guest/notes.txt": "private", "/etc/passwd": "root" },
  });
  const service = createProjectFiles(memory.filesystem, noWatch);
  await expect(service.write("out/secret.txt", "x")).rejects.toBeInstanceOf(ProjectPathError);
  await expect(service.write("out/notes.txt", "x")).rejects.toBeInstanceOf(ProjectPathError);
  await expect(service.read("out/notes.txt")).rejects.toBeInstanceOf(ProjectPathError);
  await expect(service.read("up/passwd")).rejects.toBeInstanceOf(ProjectPathError);
  await expect(service.writeMany({ "a.txt": "a", "out/b.txt": "b" })).rejects.toBeInstanceOf(
    ProjectPathError,
  );
  expect(Array.from(memory.files.keys()).toSorted()).toEqual(["/etc/passwd", "/home/guest/notes.txt"]);
  expect(memory.text("/home/guest/notes.txt")).toBe("private");
});

test("a link whose target only looks inside the project when read as text is refused", async () => {
  // `l2` is `l1/..`. Read as text that is the project root. In the filesystem `l1` leads to
  // /home/guest/x first, so `l2` is /home/guest.
  const memory = memoryFilesystem({
    links: { "/workspace/l1": "/home/guest/x", "/workspace/l2": "l1/.." },
    directories: ["/home", "/home/guest", "/home/guest/x"],
    files: { "/home/guest/existing.txt": "private" },
  });
  const service = createProjectFiles(memory.filesystem, noWatch);
  await expect(service.write("l2/escaped.txt", "x")).rejects.toBeInstanceOf(ProjectPathError);
  await expect(service.write("l2/existing.txt", "x")).rejects.toBeInstanceOf(ProjectPathError);
  await expect(service.read("l2/existing.txt")).rejects.toBeInstanceOf(ProjectPathError);
  await expect(service.move("l2/existing.txt", "stolen.txt")).rejects.toBeInstanceOf(ProjectPathError);
  expect(Array.from(memory.files.keys())).toEqual(["/home/guest/existing.txt"]);
  expect(memory.text("/home/guest/existing.txt")).toBe("private");
});

test("a directory link that stays inside the project is followed for files that exist", async () => {
  const memory = memoryFilesystem({
    links: { "/workspace/alias": "src" },
    directories: ["/workspace/src"],
    files: { "/workspace/src/main.ts": "old" },
  });
  const service = createProjectFiles(memory.filesystem, noWatch);
  expect(await service.read("alias/main.ts")).toBe("old");
  await service.write("alias/main.ts", "new");
  expect(memory.text("/workspace/src/main.ts")).toBe("new");
});

test("a link is never the entry that is read or written, and never the directory created in", async () => {
  const memory = memoryFilesystem({
    links: { "/workspace/link.txt": "real.txt", "/workspace/alias": "src" },
    directories: ["/workspace/src"],
    files: { "/workspace/real.txt": "real" },
  });
  const service = createProjectFiles(memory.filesystem, noWatch);
  await expect(service.read("link.txt")).rejects.toBeInstanceOf(ProjectPathError);
  await expect(service.write("link.txt", "x")).rejects.toBeInstanceOf(ProjectPathError);
  await expect(service.write("alias/new.ts", "x")).rejects.toBeInstanceOf(ProjectPathError);
  await expect(service.mkdir("alias/deeper")).rejects.toBeInstanceOf(ProjectPathError);
  expect(memory.text("/workspace/real.txt")).toBe("real");
});

test("a link itself can be removed, wherever it points", async () => {
  const memory = memoryFilesystem({
    links: { "/workspace/out": "/home/guest" },
    directories: ["/home/guest"],
  });
  const service = createProjectFiles(memory.filesystem, noWatch);
  await expect(service.remove("out")).resolves.toBeUndefined();
});

test("a loop of links fails instead of being followed forever", async () => {
  const memory = memoryFilesystem({ links: { "/workspace/a": "b", "/workspace/b": "a" } });
  const service = createProjectFiles(memory.filesystem, noWatch);
  await expect(service.read("a/file")).rejects.toThrow();
  await expect(service.write("a/file", "x")).rejects.toThrow();
  expect(memory.files.size).toBe(0);
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
