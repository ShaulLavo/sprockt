import { expect, test } from "bun:test";
import { ProjectPathError } from "../workspace/paths";
import { FolderGoneError } from "./errors";
import { localPathLocks, type PathLocks } from "./path-locks";
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
    if (hops > 40) throw new Error("ELOOP: too many levels of symbolic links");
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
    async remove(path) {
      // A folder goes with everything inside it.
      const target = real(path, false);
      const inside = (entry: string) => entry === target || entry.startsWith(`${target}/`);
      const removed = Array.from(files.keys()).filter(inside);
      for (const file of removed) files.delete(file);
      for (const directory of Array.from(directories)) if (inside(directory)) directories.delete(directory);
      return removed.length > 0;
    },
    async move(from, to) {
      // A folder moves with everything inside it.
      const [source, target] = [real(from, false), real(to, false)];
      const moved = (entry: string) => `${target}${entry.slice(source.length)}`;
      const inside = (entry: string) => entry === source || entry.startsWith(`${source}/`);
      for (const [file, content] of Array.from(files)) {
        if (!inside(file)) continue;
        files.delete(file);
        files.set(moved(file), content);
      }
      for (const directory of Array.from(directories)) {
        if (!inside(directory)) continue;
        directories.delete(directory);
        directories.add(moved(directory));
      }
    },
    flush() {
      const next = Promise.withResolvers<void>();
      flushes.push(next);
      return next.promise;
    },
    async lookup(path) {
      if (files.has(path)) return { kind: "file" };
      return directories.has(path) ? { kind: "dir", children: new Map() } : undefined;
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

test("a write expecting no file never replaces one that appeared after the check", async () => {
  const memory = memoryFilesystem();
  // The shell creates the file right after the service looked and found nothing.
  const readFile = memory.filesystem.readFile;
  let raced = false;
  memory.filesystem.readFile = async (path) => {
    const bytes = await readFile(path);
    if (path === "/workspace/new.txt" && !raced) {
      raced = true;
      await memory.filesystem.writeFile(path, "from the shell");
    }
    return bytes;
  };
  const service = createProjectFiles(memory.filesystem, noWatch);
  expect(await service.writeIfUnchanged("new.txt", "mine", undefined)).toEqual({
    written: false,
    current: "from the shell",
  });
  expect(memory.text("/workspace/new.txt")).toBe("from the shell");
});

test("a file created just before an exclusive restore is a conflict, even when the filesystem repeats its error", async () => {
  const memory = memoryFilesystem();
  // As Waffle does: the exclusive write fails with EEXIST because the shell created the file
  // after every check, and the next read throws that same error once more.
  const exists = new Error("EEXIST: file already exists");
  const { readFile, writeFile, resolvePath } = memory.filesystem;
  let pendingError: Error | undefined;
  let checks = 0;
  memory.filesystem.resolvePath = async (path) => {
    checks += 1;
    return resolvePath(path);
  };
  memory.filesystem.writeFile = async (path, content, mode) => {
    if (!mode?.exclusive) return writeFile(path, content, mode);
    await writeFile(path, "from the shell");
    pendingError = exists;
    throw exists;
  };
  memory.filesystem.readFile = async (path) => {
    const error = pendingError;
    pendingError = undefined;
    if (error) throw error;
    return readFile(path);
  };
  const service = createProjectFiles(memory.filesystem, noWatch);
  expect(await service.writeIfUnchanged("new.txt", "mine", undefined)).toEqual({
    written: false,
    current: "from the shell",
  });
  expect(checks).toBeGreaterThan(0);
  expect(memory.text("/workspace/new.txt")).toBe("from the shell");
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

/** The same filesystem with reads and renames slowed down, so two operations interleave as tabs do. */
const later = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The same filesystem with reads and renames slowed down, so two operations interleave as tabs
 * do. `writeMs` slows writes more, so another tab's change can land between a save's check and
 * its write.
 */
function slowed(filesystem: ProjectFilesystem, writeMs = 0): ProjectFilesystem {
  return {
    ...filesystem,
    readFile: async (path) => (await later(), filesystem.readFile(path)),
    resolvePath: async (path) => (await later(), filesystem.resolvePath(path)),
    move: async (from, to) => (await later(), filesystem.move(from, to)),
    mkdirp: async (path) => (await later(writeMs), filesystem.mkdirp(path)),
    writeFile: async (path, content, mode) => (
      await later(writeMs),
      filesystem.writeFile(path, content, mode)
    ),
  };
}

test("of two overlapping conditional saves from two tabs, the second sees the first", async () => {
  const memory = memoryFilesystem({ files: { "/workspace/shared.txt": "base\n" } });
  const locks = localPathLocks();
  // Two tabs: two services on one filesystem, sharing the workspace's locks.
  const first = createProjectFiles(slowed(memory.filesystem), noWatch, undefined, locks);
  const second = createProjectFiles(slowed(memory.filesystem), noWatch, undefined, locks);

  const outcomes = await Promise.all([
    first.writeIfUnchanged("shared.txt", "base\nfirst tab", "base\n"),
    second.writeIfUnchanged("shared.txt", "base\nsecond tab", "base\n"),
  ]);

  expect(outcomes.filter((outcome) => outcome.written)).toHaveLength(1);
  const refused = outcomes.find((outcome) => !outcome.written);
  expect(refused).toEqual({ written: false, current: memory.text("/workspace/shared.txt") });
});

test("of two overlapping moves to one free name, the second fails and keeps its source", async () => {
  const memory = memoryFilesystem({
    files: { "/workspace/a.txt": "first payload", "/workspace/b.txt": "second payload" },
  });
  const locks = localPathLocks();
  const first = createProjectFiles(slowed(memory.filesystem), noWatch, undefined, locks);
  const second = createProjectFiles(slowed(memory.filesystem), noWatch, undefined, locks);

  const moves = await Promise.allSettled([first.move("a.txt", "out.txt"), second.move("b.txt", "out.txt")]);

  expect(moves.map((move) => move.status).toSorted()).toEqual(["fulfilled", "rejected"]);
  const lost = moves[0].status === "rejected" ? "/workspace/a.txt" : "/workspace/b.txt";
  expect(memory.files.has(lost)).toBe(true);
  expect([memory.text("/workspace/out.txt")]).not.toContain(memory.text(lost));
});

test("a save racing another tab's delete of its folder never brings the folder back", async () => {
  const memory = memoryFilesystem({
    directories: ["/workspace/src"],
    files: { "/workspace/src/file.txt": "old" },
  });
  const locks = localPathLocks();
  const first = createProjectFiles(slowed(memory.filesystem, 40), noWatch, undefined, locks);
  const second = createProjectFiles(slowed(memory.filesystem), noWatch, undefined, locks);

  const [save] = await Promise.all([
    first.writeIfUnchanged("src/file.txt", "new", "old"),
    second.remove("src"),
  ]);

  expect(memory.files.has("/workspace/src/file.txt")).toBe(false);
  // Either the save came first and went with the folder, or it found the folder gone.
  if (!save.written) expect(save.current).toBeUndefined();
});

test("a save racing another tab's move of its folder lands in the moved folder or is a conflict", async () => {
  const memory = memoryFilesystem({
    directories: ["/workspace/src"],
    files: { "/workspace/src/file.txt": "old" },
  });
  const locks = localPathLocks();
  const first = createProjectFiles(slowed(memory.filesystem, 40), noWatch, undefined, locks);
  const second = createProjectFiles(slowed(memory.filesystem), noWatch, undefined, locks);

  const [save] = await Promise.all([
    first.writeIfUnchanged("src/file.txt", "new", "old"),
    second.move("src", "moved"),
  ]);

  expect(memory.files.has("/workspace/src/file.txt")).toBe(false);
  if (save.written) expect(memory.text("/workspace/moved/file.txt")).toBe("new");
  else expect(memory.text("/workspace/moved/file.txt")).toBe("old");
});

/** `alias` is a link to `real`, so `real/sub/x` and `alias/sub/x` are one file. */
const aliased = (files: Readonly<Record<string, string>>) =>
  memoryFilesystem({
    links: { "/workspace/alias": "/workspace/real" },
    directories: ["/workspace/real", "/workspace/real/sub"],
    files,
  });

test("two saves of one file through a folder link and its target: one lands, one is a conflict", async () => {
  const memory = aliased({ "/workspace/real/sub/file.txt": "base" });
  const locks = localPathLocks();
  const first = createProjectFiles(slowed(memory.filesystem), noWatch, undefined, locks);
  const second = createProjectFiles(slowed(memory.filesystem), noWatch, undefined, locks);

  const outcomes = await Promise.all([
    first.writeIfUnchanged("real/sub/file.txt", "through the folder", "base"),
    second.writeIfUnchanged("alias/sub/file.txt", "through the link", "base"),
  ]);

  expect(outcomes.filter((outcome) => outcome.written)).toHaveLength(1);
});

test("two moves to one free name spelled through a folder link and its target: one fails", async () => {
  const memory = aliased({ "/workspace/a.txt": "first payload", "/workspace/b.txt": "second payload" });
  const locks = localPathLocks();
  const first = createProjectFiles(slowed(memory.filesystem), noWatch, undefined, locks);
  const second = createProjectFiles(slowed(memory.filesystem), noWatch, undefined, locks);

  const moves = await Promise.allSettled([
    first.move("a.txt", "real/sub/out.txt"),
    second.move("b.txt", "alias/sub/out.txt"),
  ]);

  expect(moves.map((move) => move.status).toSorted()).toEqual(["fulfilled", "rejected"]);
  const kept = moves[0].status === "rejected" ? "/workspace/a.txt" : "/workspace/b.txt";
  expect(memory.files.has(kept)).toBe(true);
});

test("a write that waited while another tab deleted its folder fails instead of recreating it", async () => {
  const memory = memoryFilesystem({
    directories: ["/workspace/src"],
    files: { "/workspace/src/file.txt": "old" },
  });
  const shared = localPathLocks();
  // The write has found its folder, and is held at its locks until the delete is done.
  const deleted = Promise.withResolvers<void>();
  const held: PathLocks = {
    hold: async (request, work) => (await deleted.promise, shared.hold(request, work)),
  };
  const writer = createProjectFiles(memory.filesystem, noWatch, undefined, held);
  const deleter = createProjectFiles(memory.filesystem, noWatch, undefined, shared);

  const write = writer.write("src/file.txt", "new");
  await new Promise((resolve) => setTimeout(resolve, 5));
  await deleter.remove("src");
  deleted.resolve();

  expect(write).rejects.toBeInstanceOf(FolderGoneError);
  await write.catch(() => {});
  expect(memory.files.has("/workspace/src/file.txt")).toBe(false);
});

test("a bulk upload through a directory link locks the canonical destination against another tab's conditional save", async () => {
  const memory = memoryFilesystem({
    links: { "/workspace/container/alias": "/workspace/sibling" },
    directories: ["/workspace/container", "/workspace/sibling", "/workspace/sibling/deep"],
    files: {
      "/workspace/container/ordinary.txt": "ordinary",
      "/workspace/sibling/deep/notes.txt": "base",
    },
  });
  const locks = localPathLocks();
  // Hold Tab 2 between its read and write; without a lock on the canonical destination, Tab 1's
  // upload lands in that window and Tab 2 silently overwrites it without a conflict.
  const tab2ReadDone = Promise.withResolvers<void>();
  const releaseTab2Write = Promise.withResolvers<void>();
  const tab2Fs: ProjectFilesystem = {
    ...memory.filesystem,
    async readFile(path) {
      const bytes = await memory.filesystem.readFile(path);
      if (path === "/workspace/sibling/deep/notes.txt") {
        tab2ReadDone.resolve();
        await releaseTab2Write.promise;
      }
      return bytes;
    },
  };
  const uploader = createProjectFiles(memory.filesystem, noWatch, undefined, locks);
  const saver = createProjectFiles(tab2Fs, noWatch, undefined, locks);

  const save = saver.writeIfUnchanged("sibling/deep/notes.txt", "from tab 2", "base");
  await tab2ReadDone.promise;

  let uploadFinished = false;
  const upload = uploader
    .upload(
      [
        { path: "ordinary.txt", data: new Blob(["new ordinary"]) },
        { path: "alias/deep/notes.txt", data: new Blob(["from upload"]) },
      ],
      "container",
    )
    .then((result) => {
      uploadFinished = true;
      return result;
    });
  await later(15);
  // Tab 1's upload must wait on the canonical destination lock while Tab 2 holds it.
  expect(uploadFinished).toBe(false);
  expect(memory.text("/workspace/sibling/deep/notes.txt")).toBe("base");

  releaseTab2Write.resolve();
  const [saveOutcome] = await Promise.all([save, upload]);
  expect(saveOutcome).toEqual({ written: true });
  // Tab 1 ran after Tab 2 released the lock, so Tab 1's upload was not overwritten unseen.
  expect(memory.text("/workspace/sibling/deep/notes.txt")).toBe("from upload");
});

test("writeMany through a directory link locks the canonical destination against another tab's conditional save", async () => {
  const memory = memoryFilesystem({
    links: { "/workspace/container/alias": "/workspace/sibling" },
    directories: ["/workspace/container", "/workspace/sibling", "/workspace/sibling/deep"],
    files: {
      "/workspace/container/ordinary.txt": "ordinary",
      "/workspace/sibling/deep/notes.txt": "base",
    },
  });
  const locks = localPathLocks();
  const uploader = createProjectFiles(slowed(memory.filesystem, 20), noWatch, undefined, locks);
  const saver = createProjectFiles(slowed(memory.filesystem, 20), noWatch, undefined, locks);

  const [saveOutcome] = await Promise.all([
    saver.writeIfUnchanged("sibling/deep/notes.txt", "from saver", "base"),
    uploader.writeMany({
      "container/ordinary.txt": "new ordinary",
      "container/alias/deep/notes.txt": "from writeMany",
    }),
  ]);
  // Either writeMany ran first (saver saw a conflict) or saver ran first (writeMany replaced it after).
  if (saveOutcome.written) expect(memory.text("/workspace/sibling/deep/notes.txt")).toBe("from writeMany");
  else expect(saveOutcome).toEqual({ written: false, current: "from writeMany" });
});

test("a bulk write revalidates under the lock when a symlink is repointed before locks are granted", async () => {
  const links: Record<string, string> = { "/workspace/container/alias": "/workspace/first" };
  const memory = memoryFilesystem({
    links,
    directories: ["/workspace/container", "/workspace/first", "/workspace/second"],
    files: { "/workspace/first/notes.txt": "first", "/workspace/second/notes.txt": "second" },
  });
  const shared = localPathLocks();
  const lockedPaths: string[][] = [];
  let repointed = false;
  const spyLocks: PathLocks = {
    async hold(request, work) {
      lockedPaths.push(request.exclusive.toSorted());
      if (!repointed) {
        repointed = true;
        links["/workspace/container/alias"] = "/workspace/second";
      }
      return shared.hold(request, work);
    },
  };
  const service = createProjectFiles(memory.filesystem, noWatch, undefined, spyLocks);
  await service.writeMany({
    "container/ordinary.txt": "ok",
    "container/alias/notes.txt": "updated",
  });
  // First attempt planned against /workspace/first, revalidated and saw /workspace/second, then retried with /workspace/second locked.
  expect(lockedPaths).toHaveLength(2);
  expect(lockedPaths[0]).toContain("/workspace/first/notes.txt");
  expect(lockedPaths[1]).toContain("/workspace/second/notes.txt");
  expect(memory.text("/workspace/first/notes.txt")).toBe("first");
  expect(memory.text("/workspace/second/notes.txt")).toBe("updated");
});

test("a bulk write through a symlink holds a shared lock on the traversed link entry", async () => {
  const memory = memoryFilesystem({
    links: { "/workspace/container/alias": "/workspace/sibling" },
    directories: ["/workspace/container", "/workspace/sibling", "/workspace/sibling/deep"],
    files: { "/workspace/sibling/deep/notes.txt": "base" },
  });
  const locks = localPathLocks();
  const writeStarted = Promise.withResolvers<void>();
  const finishWrite = Promise.withResolvers<void>();
  const gatedFs: ProjectFilesystem = {
    ...memory.filesystem,
    async writeFile(path, content, mode) {
      if (path === "/workspace/container/alias/deep/notes.txt") {
        writeStarted.resolve();
        await finishWrite.promise;
      }
      return memory.filesystem.writeFile(path, content, mode);
    },
  };
  const uploader = createProjectFiles(gatedFs, noWatch, undefined, locks);
  const remover = createProjectFiles(memory.filesystem, noWatch, undefined, locks);

  const bulk = uploader.writeMany({ "container/alias/deep/notes.txt": "updated" });
  await writeStarted.promise;

  let removed = false;
  const removing = remover.remove("container/alias").then(() => (removed = true));
  await later(15);
  // Removing the traversed link must wait while the bulk write holds its shared lock.
  expect(removed).toBe(false);

  finishWrite.resolve();
  await Promise.all([bulk, removing]);
  expect(removed).toBe(true);
  expect(memory.text("/workspace/sibling/deep/notes.txt")).toBe("updated");
});

test("a failed upload keeps its lock until started operations settle, stops new work, and publishes partial writes", async () => {
  const memory = memoryFilesystem({ directories: ["/workspace/docs"] });
  const locks = localPathLocks();
  const uploader = createProjectFiles(memory.filesystem, noWatch, undefined, locks);
  const deleter = createProjectFiles(memory.filesystem, noWatch, undefined, locks);

  const edits: (readonly string[])[] = [];
  uploader.subscribeEdits((paths) => edits.push(paths));
  const changes: string[][] = [];
  uploader.subscribe((change) => changes.push(Array.from(change.paths)));

  const badRead = Promise.withResolvers<ArrayBuffer>();
  const slowRead = Promise.withResolvers<ArrayBuffer>();
  const badBlob = { arrayBuffer: () => badRead.promise } as unknown as Blob;
  const slowBlob = { arrayBuffer: () => slowRead.promise } as unknown as Blob;

  let uploadSettled = false;
  const upload = uploader
    .upload(
      [
        { path: "done.txt", data: new Blob(["already written"]) },
        { path: "bad.txt", data: badBlob },
        { path: "slow.txt", data: slowBlob },
      ],
      "docs",
    )
    .catch((error: unknown) => {
      uploadSettled = true;
      return error;
    });

  // Wait for done.txt to finish writing, then fail bad.txt while slow.txt is still reading.
  await later(15);
  expect(memory.text("/workspace/docs/done.txt")).toBe("already written");
  badRead.reject(new Error("source file disappeared"));
  await later(15);

  // Another tab tries to delete the upload directory right after bad.txt failed.
  let deleted = false;
  const removal = deleter.remove("docs").then(() => (deleted = true));
  await later(15);

  // Lock must still be held (and upload not settled) until slow.txt settles.
  expect(uploadSettled).toBe(false);
  expect(deleted).toBe(false);

  // Once slow.txt's delayed read resolves, it must NOT write because the upload already aborted.
  slowRead.resolve(new TextEncoder().encode("late sibling").buffer);
  const error = await upload;
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe("source file disappeared");
  await removal;
  expect(deleted).toBe(true);
  // The delayed sibling never recreated docs after the delete.
  expect(memory.files.has("/workspace/docs/slow.txt")).toBe(false);
  expect(memory.files.has("/workspace/docs/done.txt")).toBe(false);

  // Partial write of done.txt published persistence and change/edit notifications.
  expect(uploader.saveState()).toBe("saving");
  expect(edits).toEqual([["docs/done.txt"]]);
  await later(70);
  expect(changes.flat()).toContain("docs/done.txt");
  await memory.finishFlushes();
  expect(uploader.saveState()).toBe("saved");
});

test("a bulk write locks every link in a 17-hop chain supported by Waffle against a concurrent move", async () => {
  const links: Record<string, string> = {};
  for (let index = 1; index < 17; index += 1) {
    links[`/workspace/chain/l${index}`] = `/workspace/chain/l${index + 1}`;
  }
  links["/workspace/chain/l17"] = "/workspace/original";
  const memory = memoryFilesystem({
    links,
    directories: ["/workspace/chain", "/workspace/original", "/workspace/replacement"],
    files: {
      "/workspace/original/notes.txt": "before",
      "/workspace/replacement/notes.txt": "untouched",
    },
  });
  const locks = localPathLocks();
  const writeStarted = Promise.withResolvers<void>();
  const finishWrite = Promise.withResolvers<void>();
  const gatedFs: ProjectFilesystem = {
    ...memory.filesystem,
    async writeFile(path, content, mode) {
      if (path === "/workspace/chain/l1/notes.txt") {
        writeStarted.resolve();
        await finishWrite.promise;
      }
      return memory.filesystem.writeFile(path, content, mode);
    },
  };
  const writer = createProjectFiles(gatedFs, noWatch, undefined, locks);
  const mover = createProjectFiles(memory.filesystem, noWatch, undefined, locks);

  const bulk = writer.writeMany({ "chain/l1/notes.txt": "from bulk" });
  await writeStarted.promise;

  // A second FileService tries to move the 17th link aside while the bulk write holds its locks.
  let moved = false;
  const swap = mover.move("chain/l17", "chain/l17-aside").then(() => (moved = true));
  await later(15);
  expect(moved).toBe(false);

  finishWrite.resolve();
  await Promise.all([bulk, swap]);
  expect(moved).toBe(true);
  expect(memory.text("/workspace/original/notes.txt")).toBe("from bulk");
  expect(memory.text("/workspace/replacement/notes.txt")).toBe("untouched");
});

function symlinkChainFilesystem(length: number) {
  const links: Record<string, string> = {};
  for (let index = 1; index < length; index += 1) {
    links[`/workspace/chain/l${index}`] = `/workspace/chain/l${index + 1}`;
  }
  links[`/workspace/chain/l${length}`] = "/workspace/target";
  return memoryFilesystem({
    links,
    directories: ["/workspace/chain", "/workspace/target"],
    files: { "/workspace/target/notes.txt": "before" },
  });
}

test("a bulk write locks a 40-hop symlink chain and fails closed on a 41-hop chain", async () => {
  const forty = symlinkChainFilesystem(40);
  const lockedShared: string[][] = [];
  const spyLocks: PathLocks = {
    hold(request, work) {
      lockedShared.push(Array.from(request.shared ?? []));
      return localPathLocks().hold(request, work);
    },
  };
  const okService = createProjectFiles(forty.filesystem, noWatch, undefined, spyLocks);
  await okService.writeMany({ "chain/l1/notes.txt": "forty" });
  expect(forty.text("/workspace/target/notes.txt")).toBe("forty");
  expect(lockedShared[0]).toContain("/workspace/chain/l40");

  // 41 hops exceeds the resolver cap: must fail closed and write nothing.
  const fortyOne = symlinkChainFilesystem(41);
  const failService = createProjectFiles(fortyOne.filesystem, noWatch);
  await expect(failService.writeMany({ "chain/l1/notes.txt": "too deep" })).rejects.toThrow(/ELOOP/);
  expect(fortyOne.text("/workspace/target/notes.txt")).toBe("before");
});

test("exists detects occupied paths including Unix sockets omitted by readdir", async () => {
  const memory = memoryFilesystem({
    directories: ["/workspace/dest"],
    files: { "/workspace/dest/file.txt": "ok" },
  });
  const fsWithSocket: ProjectFilesystem = {
    ...memory.filesystem,
    async resolvePath(path) {
      if (path === "/workspace/dest/sock.txt") return { kind: "socket", path };
      return memory.filesystem.resolvePath(path);
    },
    async lookup(path) {
      if (path === "/workspace/dest/sock.txt") return { kind: "socket" };
      const entry = await memory.filesystem.lookup(path);
      if (path === "/workspace/dest" && entry?.kind === "dir") {
        const children = new Map(entry.children);
        children.set("file.txt", { kind: "file" });
        children.set("sock.txt", { kind: "socket" });
        return { kind: "dir", children };
      }
      return entry;
    },
  };
  const files = createProjectFiles(fsWithSocket, noWatch);
  expect((await files.readdir("dest"))?.map((e) => e.name)).toEqual(["file.txt"]);
  expect(await files.exists("dest/file.txt")).toBe(true);
  expect(await files.exists("dest/sock.txt")).toBe(true);
  expect(await files.exists("dest/missing.txt")).toBe(false);
});

function meteredFilesystem(filesystem: ProjectFilesystem, quota = 1024) {
  let inFlight = 0;
  let peak = 0;
  let calls = 0;

  async function track<T>(work: () => Promise<T>): Promise<T> {
    calls += 1;
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

  const wrapped: ProjectFilesystem = {
    mkdirp: (path) => track(() => filesystem.mkdirp(path)),
    writeFile: (path, content, mode) => track(() => filesystem.writeFile(path, content, mode)),
    readFile: (path) => track(() => filesystem.readFile(path)),
    listFiles: (path) => track(() => filesystem.listFiles(path)),
    remove: (path) => track(() => filesystem.remove(path)),
    move: (from, to) => track(() => filesystem.move(from, to)),
    flush: () => track(() => filesystem.flush()),
    resolvePath: (path) => track(() => filesystem.resolvePath(path)),
    lookup: (path) => track(() => filesystem.lookup(path)),
  };

  return {
    filesystem: wrapped,
    get peak() {
      return peak;
    },
    get calls() {
      return calls;
    },
    resetPeak() {
      peak = 0;
    },
  };
}

function bulkEntries(count: number, prefix = "v1"): Record<string, string> {
  const files: Record<string, string> = {};
  for (let index = 0; index < count; index += 1) {
    const path = index < 300 ? `top-${index}.txt` : `dir-${Math.floor((index - 300) / 20)}/file-${index}.txt`;
    files[path] = `${prefix}:${index}`;
  }
  return files;
}

test("writeMany of 1,500 files bounds concurrent filesystem RPCs on both fresh and existing trees", async () => {
  const memory = memoryFilesystem();
  const metered = meteredFilesystem(memory.filesystem);
  const service = createProjectFiles(metered.filesystem, noWatch);

  await service.writeMany(bulkEntries(1500, "v1"));
  expect(memory.files.size).toBe(1500);
  expect(memory.text("/workspace/top-0.txt")).toBe("v1:0");
  expect(memory.text("/workspace/dir-59/file-1499.txt")).toBe("v1:1499");
  expect(metered.peak).toBeLessThanOrEqual(8);
  expect(metered.calls).toBeGreaterThan(1500);

  // Second pass over existing directories exercises every inspector lookup too.
  await memory.finishFlushes();
  metered.resetPeak();
  await service.writeMany(bulkEntries(1500, "v2"));
  expect(memory.files.size).toBe(1500);
  expect(memory.text("/workspace/top-0.txt")).toBe("v2:0");
  expect(memory.text("/workspace/dir-59/file-1499.txt")).toBe("v2:1499");
  expect(metered.peak).toBeLessThanOrEqual(8);
});

test("writeMany of 1,500 files still rejects atomically with bounded RPCs when the last path escapes", async () => {
  const memory = memoryFilesystem({
    links: { "/workspace/out": "/etc" },
    directories: ["/etc"],
  });
  const metered = meteredFilesystem(memory.filesystem);
  const service = createProjectFiles(metered.filesystem, noWatch);
  const files = { ...bulkEntries(1500), "out/escaped.txt": "bad" };

  await expect(service.writeMany(files)).rejects.toBeInstanceOf(ProjectPathError);
  expect(memory.files.size).toBe(0);
  expect(metered.peak).toBeLessThanOrEqual(8);
});

test("upload of 1,500 files bounds concurrent filesystem RPCs", async () => {
  const memory = memoryFilesystem();
  const metered = meteredFilesystem(memory.filesystem);
  const service = createProjectFiles(metered.filesystem, noWatch);
  const items = Object.entries(bulkEntries(1500)).map(([path, text]) => ({
    path,
    data: new Blob([text]),
  }));

  const result = await service.upload(items, "");
  expect(result.written).toHaveLength(1500);
  expect(result.skipped).toBe(0);
  expect(memory.files.size).toBe(1500);
  expect(memory.text("/workspace/dir-59/file-1499.txt")).toBe("v1:1499");
  expect(metered.peak).toBeLessThanOrEqual(8);
});
