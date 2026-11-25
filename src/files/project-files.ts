// FileService on top of a filesystem and a watcher, with nothing browser-specific in it, so the
// rules it enforces (the project boundary, what "saved" means) are tested without a runtime.
import { createSignal } from "solid-js";
import {
  isInsideProject,
  linkTarget,
  PROJECT_ROOT,
  projectPath,
  ProjectPathError,
  projectRelative,
} from "../workspace/paths";
import { createPersistence, type SaveState } from "./persistence";
import type { FileService, WriteOutcome } from "./service";
import { isHeavyPath, touchesProject } from "./tree";

export interface ResolvedEntry {
  readonly path: string;
  readonly kind: "file" | "dir" | "socket" | "symlink";
  /** Where a symbolic link points, as written in the link. */
  readonly target?: string;
}

/** The part of Waffle's filesystem the service needs. */
export interface ProjectFilesystem {
  mkdirp(path: string): Promise<void>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  readFile(path: string): Promise<Uint8Array | undefined>;
  listFiles(path: string): Promise<string[]>;
  remove(path: string): Promise<boolean>;
  move(from: string, to: string): Promise<void>;
  flush(): Promise<void>;
  /** The entry at `path` itself: a symbolic link is reported, not followed. */
  resolvePath(path: string): Promise<ResolvedEntry | undefined>;
}

/** Calls back with the changed paths (relative to the filesystem root). Returns the stop. */
export type WatchFiles = (onChange: (names: readonly (string | null)[]) => void) => () => void;

/** The service plus what only the workspace session may do to it. */
export interface ProjectFiles extends FileService {
  /** Storage is gone: every later write is refused with `reason`. */
  revoke(reason: Error): void;
}

/** How long changes are gathered before the explorer is told: an install touches many files. */
const COALESCE_MS = 50;
/** A chain of links longer than this is treated as a loop. */
const MAX_LINKS = 16;

const parentOf = (absolute: string) => absolute.slice(0, absolute.lastIndexOf("/"));
type Lookup = (path: string) => Promise<ResolvedEntry | undefined>;

/**
 * The real location of an absolute path, following symbolic links one component at a time. A
 * link that leads out of the project is refused: the service never reads or writes through it.
 */
async function realPath(
  lookup: Lookup,
  base: string,
  parts: readonly string[],
  hops: number,
): Promise<string> {
  const [name, ...rest] = parts;
  if (name === undefined) return base;
  const next = `${base}/${name}`;
  const entry = await lookup(next);
  // Nothing exists from here on, so there is no link left to follow.
  if (!entry) return [next].concat(rest).join("/");
  if (entry.kind !== "symlink") return realPath(lookup, next, rest, hops);
  const target = linkTarget(next, entry.target ?? "");
  if (!isInsideProject(target))
    throw new ProjectPathError(next, `it is a link to ${target}, outside the project`);
  if (hops >= MAX_LINKS) throw new ProjectPathError(next, "its links form a loop");
  return realPath(lookup, "", target.split("/").slice(1).concat(rest), hops + 1);
}

export function createProjectFiles(filesystem: ProjectFilesystem, watch: WatchFiles): ProjectFiles {
  const [revision, setRevision] = createSignal(0);
  const [saveState, setSaveState] = createSignal<SaveState>("saved");
  const [writable, setWritable] = createSignal(true);
  const persistence = createPersistence(() => filesystem.flush(), setSaveState);
  const decoder = new TextDecoder();
  let revoked: Error | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function announce(): void {
    timer = undefined;
    setRevision((value) => value + 1);
  }

  const changedProject = () => void (timer ??= setTimeout(announce, COALESCE_MS));

  /** One memo per operation: a bulk write checks each directory once, not once per file. */
  function confiner(): (absolute: string, followLast: boolean) => Promise<void> {
    const seen = new Map<string, Promise<ResolvedEntry | undefined>>();
    const lookup: Lookup = (path) => {
      const known = seen.get(path) ?? filesystem.resolvePath(path);
      seen.set(path, known);
      return known;
    };
    return async (absolute, followLast) => {
      const parts = (followLast ? absolute : parentOf(absolute)).split("/").slice(1);
      await realPath(lookup, "", parts, 0);
    };
  }

  /** Runs a change: refused when storage is gone, `saving` from now until it is flushed. */
  async function mutate<T>(change: () => Promise<T>): Promise<T> {
    if (revoked) throw revoked;
    const end = persistence.begin();
    try {
      const result = await change();
      persistence.touch();
      changedProject();
      return result;
    } finally {
      end();
    }
  }

  async function writeConfined(
    confine: ReturnType<typeof confiner>,
    path: string,
    content: string | Uint8Array,
  ) {
    const absolute = projectPath(path);
    await confine(absolute, true);
    await filesystem.mkdirp(parentOf(absolute));
    await filesystem.writeFile(absolute, content);
  }

  async function readConfined(path: string): Promise<Uint8Array | undefined> {
    const absolute = projectPath(path);
    await confiner()(absolute, true);
    return filesystem.readFile(absolute);
  }

  async function readText(path: string): Promise<string | undefined> {
    const bytes = await readConfined(path);
    return bytes && decoder.decode(bytes);
  }

  // Everything that changes files without going through this service (the shell, Bun, another
  // tab) arrives here. All of it needs a flush; only project files concern the explorer.
  const stopWatching = watch((names) => {
    if (revoked) return;
    persistence.touch();
    if (touchesProject(names)) changedProject();
  });

  return {
    revision,
    saveState,
    writable,
    saved: () => persistence.settled(),
    async list() {
      const files = await filesystem.listFiles(PROJECT_ROOT);
      return files.flatMap((file) => {
        const relative = projectRelative(file);
        return relative && !isHeavyPath(relative) ? [relative] : [];
      });
    },
    read: readText,
    readBytes: readConfined,
    write: (path, content) => mutate(() => writeConfined(confiner(), path, content)),
    writeIfUnchanged: (path, content, expected) =>
      mutate(async (): Promise<WriteOutcome> => {
        const current = await readText(path);
        if (current !== expected) return { written: false, current };
        await writeConfined(confiner(), path, content);
        return { written: true };
      }),
    async writeMany(files) {
      const entries = Object.entries(files);
      // Every path is checked before the first byte is written: a bad entry writes nothing.
      for (const [path] of entries) projectPath(path);
      const confine = confiner();
      await mutate(async () => {
        // Links are checked for the whole set first, for the same reason.
        await Promise.all(entries.map(([path]) => confine(projectPath(path), true)));
        await Promise.all(entries.map(([path, content]) => writeConfined(confine, path, content)));
      });
    },
    mkdir: (path) =>
      mutate(async () => {
        const absolute = projectPath(path);
        await confiner()(absolute, true);
        await filesystem.mkdirp(absolute);
      }),
    remove: (path) =>
      mutate(async () => {
        const absolute = projectPath(path);
        // The entry itself is removed, link or not; only the way to it must stay inside.
        await confiner()(absolute, false);
        await filesystem.remove(absolute);
      }),
    move: (from, to) =>
      mutate(async () => {
        const source = projectPath(from);
        const destination = projectPath(to);
        const confine = confiner();
        await Promise.all([confine(source, false), confine(destination, false)]);
        await filesystem.mkdirp(parentOf(destination));
        await filesystem.move(source, destination);
      }),
    revoke(reason) {
      revoked = reason;
      setWritable(false);
      persistence.stop(reason);
    },
    dispose() {
      clearTimeout(timer);
      stopWatching();
    },
  };
}
