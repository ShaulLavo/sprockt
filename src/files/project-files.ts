// FileService on top of a filesystem and a watcher, with nothing browser-specific in it, so the
// rules it enforces (the project boundary, what "saved" means) are tested without a runtime.
import type { SizeLookup } from "./size";
import { createSignal } from "solid-js";
import { createZipBlob } from "../lib/zip/zip";
import {
  isInsideProject,
  PROJECT_ROOT,
  projectPath,
  ProjectPathError,
  projectRelative,
} from "../workspace/paths";
import { DestinationExistsError, MoveIntoItselfError } from "./errors";
import { isSameOrInside, joinPath, rebase, safeRelativePath } from "./paths";
import { localPathLocks, type PathLocks } from "./path-locks";
import { createPersistence, type SaveState } from "./persistence";
import type { DirEntry, FileChange, FileService, UploadItem, UploadResult, WriteOutcome } from "./service";
import { isHeavyPath, sortEntries, toProjectPath } from "./tree";

export interface ResolvedEntry {
  readonly path: string;
  readonly kind: "file" | "dir" | "socket" | "symlink";
  /** Where a symbolic link points, as written in the link. */
  readonly target?: string;
}

/** The part of Waffle's filesystem the service needs. */
export interface ProjectFilesystem {
  mkdirp(path: string): Promise<void>;
  /** `exclusive`: fail when the path already exists instead of replacing it. */
  writeFile(path: string, content: string | Uint8Array, mode?: { exclusive?: boolean }): Promise<void>;
  readFile(path: string): Promise<Uint8Array | undefined>;
  listFiles(path: string): Promise<string[]>;
  remove(path: string): Promise<boolean>;
  move(from: string, to: string): Promise<void>;
  flush(): Promise<void>;
  /** The entry at `path` itself: a symbolic link is reported, not followed. */
  resolvePath(path: string): Promise<ResolvedEntry | undefined>;
  /** The entry at `path`; a directory lists its children by name. */
  lookup(path: string): Promise<LookedUpEntry | undefined>;
}

export interface LookedUpEntry {
  readonly kind: "file" | "dir" | "socket" | "symlink";
  readonly children?: ReadonlyMap<string, { readonly kind: "file" | "dir" | "socket" | "symlink" }>;
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
/** Files read or written at once while uploading or exporting, to bound memory. */
const BATCH = 8;

interface Pending {
  paths: Set<string>;
  moves: { from: string; to: string; operation: number }[];
  removed: Set<string>;
  reset: boolean;
}

/** What one change did, beyond the paths it touched: filled in by the change itself. */
interface Effects {
  readonly paths: string[];
  readonly moves: { from: string; to: string; operation: number }[];
  readonly removed: string[];
}

const emptyPending = (): Pending => ({ paths: new Set(), moves: [], removed: new Set(), reset: false });

async function inBatches<T>(items: readonly T[], work: (item: T) => Promise<void>): Promise<void> {
  for (let start = 0; start < items.length; start += BATCH) {
    // Each batch finishes before the next starts; that is what bounds the memory.
    // oxlint-disable-next-line no-await-in-loop
    await Promise.all(items.slice(start, start + BATCH).map(work));
  }
}

const parentOf = (absolute: string) => absolute.slice(0, absolute.lastIndexOf("/"));
type Lookup = (path: string) => Promise<ResolvedEntry | undefined>;

/** WASI error numbers for "no such file or directory" and "not a directory". */
const MISSING: ReadonlySet<unknown> = new Set([44, 54]);

/**
 * The filesystem answers "nothing there" in two ways: no entry when only the last name is
 * missing, and an error when a directory on the way is. Both mean the path does not exist yet.
 */
function absentWhenMissing(error: unknown): undefined {
  const missing = typeof error === "object" && error !== null && "errno" in error && MISSING.has(error.errno);
  if (!missing) throw error;
  return undefined;
}

/**
 * Checks where a path really leads, right before it is used. The filesystem resolves the
 * path itself, so links are followed exactly as the operation will follow them; nothing about
 * links is worked out here. Two things are refused:
 *
 * - a path the filesystem resolves to a place outside the project, and
 * - a symbolic link as the entry to read or write (`through`), or as the directory a new entry
 *   would be created in. The filesystem reports such a link without following it, so where it
 *   leads cannot be checked; it is not followed at all.
 *
 * For a path that does not exist yet, the nearest existing directory above it is checked.
 */
async function confirmInside(lookup: Lookup, absolute: string, through: boolean): Promise<void> {
  if (!isInsideProject(absolute)) throw new ProjectPathError(absolute, "it is outside the project");
  const entry = await lookup(absolute).catch(absentWhenMissing);
  if (!entry) return confirmInside(lookup, parentOf(absolute), true);
  if (!isInsideProject(entry.path)) {
    throw new ProjectPathError(absolute, `it leads to ${entry.path}, outside the project`);
  }
  if (through && entry.kind === "symlink") {
    throw new ProjectPathError(absolute, "it is a symbolic link, and links are not followed here");
  }
}

/**
 * `sizeOf` measures a file at an absolute path without reading it; without one, `size` reads the
 * file (in-memory filesystems in tests).
 *
 * `locks` makes each check-and-act one step across the tabs attached to the workspace (see
 * `path-locks.ts`); the default only orders operations within this page.
 */
export function createProjectFiles(
  filesystem: ProjectFilesystem,
  watch: WatchFiles,
  sizeOf?: SizeLookup,
  locks: PathLocks = localPathLocks(),
): ProjectFiles {
  const [revision, setRevision] = createSignal(0);
  const [saveState, setSaveState] = createSignal<SaveState>("saved");
  const [writable, setWritable] = createSignal(true);
  // Waffle returns a failed change to its caller and keeps the same error to throw again at the
  // next flush. An error whose operation already reported it to its own caller is not a fault of
  // the workspace, so a flush that throws exactly that error is tried again; any other error,
  // including one that cannot be matched to an operation, still fails the save state.
  const reported = new WeakSet<object>();
  const remember = (error: unknown): void => {
    if (typeof error === "object" && error !== null) reported.add(error);
  };
  async function flushUnlessReported(): Promise<void> {
    try {
      await filesystem.flush();
    } catch (error) {
      if (typeof error !== "object" || error === null || !reported.has(error)) throw error;
      await filesystem.flush();
    }
  }
  const persistence = createPersistence(flushUnlessReported, setSaveState);
  const found = (path: string) => pastReported(() => filesystem.resolvePath(path)).catch(absentWhenMissing);
  /**
   * Runs a read that Waffle may fail with an error an operation already reported (it throws the
   * failed change once more on the next call): that error is not this read's, so it runs again.
   */
  async function pastReported<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (error) {
      if (typeof error !== "object" || error === null || !reported.has(error)) throw error;
      return read();
    }
  }
  const decoder = new TextDecoder();
  const listeners = new Set<(change: FileChange) => void>();
  let revoked: Error | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = emptyPending();
  let moveOperations = 0;

  function announce(): void {
    timer = undefined;
    const batch = pending;
    pending = emptyPending();
    setRevision((value) => value + 1);
    const change: FileChange = {
      paths: batch.reset ? [] : Array.from(batch.paths),
      reset: batch.reset,
      moves: batch.moves,
      removed: Array.from(batch.removed),
    };
    for (const listener of listeners) listener(change);
  }

  /** Something in the project changed: the paths that did, and whether events may be missing. */
  function changedProject(effects: Partial<Effects> = {}, reset = false): void {
    for (const path of effects.paths ?? []) pending.paths.add(path);
    pending.moves.push(...(effects.moves ?? []));
    for (const path of effects.removed ?? []) pending.removed.add(path);
    pending.reset ||= reset;
    timer ??= setTimeout(announce, COALESCE_MS);
  }

  /** One memo per operation: a bulk write checks each directory once, not once per file. */
  function confiner(): (absolute: string, followLast: boolean) => Promise<void> {
    const seen = new Map<string, Promise<ResolvedEntry | undefined>>();
    const lookup: Lookup = (path) => {
      const known = seen.get(path) ?? filesystem.resolvePath(path);
      seen.set(path, known);
      return known;
    };
    // `through`: the operation reads or writes the entry. Otherwise it acts on the entry
    // itself (remove, move), which may be a link; then only the way to it has to stay inside.
    return async (absolute, through) => {
      if (through) return confirmInside(lookup, absolute, true);
      await confirmInside(lookup, parentOf(absolute), true);
      await confirmInside(lookup, absolute, false);
    };
  }

  /** Runs a change: refused when storage is gone, `saving` from now until it is flushed. */
  async function mutate<T>(change: (effects: Effects) => Promise<T>, paths: readonly string[]): Promise<T> {
    if (revoked) throw revoked;
    const end = persistence.begin();
    const effects: Effects = { paths: Array.from(paths), moves: [], removed: [] };
    try {
      const result = await change(effects);
      persistence.touch();
      changedProject(effects);
      return result;
    } catch (error) {
      remember(error);
      throw error;
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

  /** A write that waits for any other tab's check-and-act on the same file. */
  const writeLocked = (confine: ReturnType<typeof confiner>, path: string, content: string | Uint8Array) =>
    locks.hold([projectPath(path)], () => writeConfined(confine, path, content));

  async function readConfined(path: string): Promise<Uint8Array | undefined> {
    const absolute = projectPath(path);
    await confiner()(absolute, true);
    return filesystem.readFile(absolute);
  }

  /** Writes a file that must not exist yet. False when the name is taken; nothing is replaced. */
  async function writeExclusive(path: string, content: string | Uint8Array): Promise<boolean> {
    const absolute = projectPath(path);
    await confiner()(absolute, true);
    await filesystem.mkdirp(parentOf(absolute));
    // Looked at first, so the common clash fails without a failed write at all.
    if (await found(absolute)) return false;
    try {
      await filesystem.writeFile(absolute, content, { exclusive: true });
      return true;
    } catch (error) {
      remember(error);
      // Whatever the filesystem called it, a name that is taken is the answer the caller needs.
      if (await found(absolute)) return false;
      throw error;
    }
  }

  async function readText(path: string): Promise<string | undefined> {
    const bytes = await readConfined(path);
    return bytes && decoder.decode(bytes);
  }

  /** Project files without `node_modules` and `.git`. */
  async function projectFiles(): Promise<string[]> {
    const files = await filesystem.listFiles(PROJECT_ROOT);
    return files.flatMap((file) => {
      const relative = projectRelative(file);
      return relative && !isHeavyPath(relative) ? [relative] : [];
    });
  }

  /** Project paths of the files inside `absolute` when it is a directory; none for a file. */
  async function filesInside(absolute: string): Promise<string[]> {
    if ((await found(absolute))?.kind !== "dir") return [];
    const files = await filesystem.listFiles(absolute);
    return files.flatMap((file) => projectRelative(file) ?? []);
  }

  async function upload(items: readonly UploadItem[], directory: string): Promise<UploadResult> {
    let skipped = 0;
    const accepted = items.flatMap((item) => {
      const relative = safeRelativePath(item.path);
      const path = relative && joinPath(directory, relative);
      if (!relative || !path || isHeavyPath(relative)) {
        skipped += 1;
        return [];
      }
      return [{ path, data: item.data }];
    });
    // Every path is checked before the first byte is written, as in writeMany.
    for (const { path } of accepted) projectPath(path);
    await mutate(
      () =>
        inBatches(accepted, async ({ path, data }) => {
          // The bytes are read first and the links checked afterwards, with a fresh check per
          // entry: the check must describe the filesystem as it is when the write happens.
          const bytes = data && new Uint8Array(await data.arrayBuffer());
          if (bytes) return writeLocked(confiner(), path, bytes);
          const absolute = projectPath(path);
          await confiner()(absolute, true);
          await filesystem.mkdirp(absolute);
        }),
      accepted.map((item) => item.path),
    );
    return { written: accepted.map((item) => item.path), skipped };
  }

  // Everything that changes files without going through this service (the shell, Bun, another
  // tab) arrives here. All of it needs a flush; only project files concern the explorer.
  const stopWatching = watch((names) => {
    if (revoked) return;
    persistence.touch();
    const paths: string[] = [];
    let reset = false;
    for (const name of names) {
      const path = name === null ? undefined : toProjectPath(name);
      if (name === null) reset = true;
      else if (path !== undefined) paths.push(path);
    }
    if (reset || paths.length > 0) changedProject({ paths }, reset);
  });

  return {
    revision,
    saveState,
    writable,
    saved: () => persistence.settled(),
    list: projectFiles,
    async readdir(path) {
      const absolute = path === "" ? PROJECT_ROOT : projectPath(path);
      if (path !== "") await confiner()(absolute, true);
      const entry = await filesystem.lookup(absolute);
      if (entry?.kind !== "dir") return undefined;
      const entries: DirEntry[] = [];
      for (const [name, meta] of entry.children ?? []) {
        if (meta.kind === "dir") entries.push({ name, kind: "directory" });
        else if (meta.kind !== "socket") entries.push({ name, kind: "file" });
      }
      return sortEntries(entries);
    },
    read: readText,
    readBytes: readConfined,
    async size(path) {
      const absolute = projectPath(path);
      await confiner()(absolute, true);
      if (sizeOf) return sizeOf.size(absolute);
      return (await filesystem.readFile(absolute))?.length;
    },
    write: (path, content) => mutate(() => writeLocked(confiner(), path, content), [path]),
    // The read, the comparison and the write hold the file's lock together, so a save in another
    // tab cannot land between them: the second of two overlapping saves sees the first and fails.
    writeIfUnchanged: (path, content, expected) =>
      mutate(
        () =>
          locks.hold([projectPath(path)], async (): Promise<WriteOutcome> => {
            const current = await readText(path);
            if (current !== expected) return { written: false, current };
            if (expected !== undefined) {
              await writeConfined(confiner(), path, content);
              return { written: true };
            }
            // Expected absent: create it exclusively, so a file that appears between the check and
            // the write (the shell, another tab) is reported as a conflict, never replaced.
            if (await writeExclusive(path, content)) return { written: true };
            return { written: false, current: await pastReported(() => readText(path)) };
          }),
        [path],
      ),
    async writeMany(files) {
      const entries = Object.entries(files);
      // Every path is checked before the first byte is written: a bad entry writes nothing.
      for (const [path] of entries) projectPath(path);
      const confine = confiner();
      await mutate(
        async () => {
          // Links are checked for the whole set first, for the same reason.
          await Promise.all(entries.map(([path]) => confine(projectPath(path), true)));
          await Promise.all(entries.map(([path, content]) => writeLocked(confine, path, content)));
        },
        entries.map(([path]) => path),
      );
    },
    mkdir: (path) =>
      mutate(async () => {
        const absolute = projectPath(path);
        await confiner()(absolute, true);
        await filesystem.mkdirp(absolute);
      }, [path]),
    create: (path, content = "") =>
      mutate(
        () =>
          locks.hold([projectPath(path)], async () => {
            if (!(await writeExclusive(path, content))) throw new DestinationExistsError(path);
          }),
        [path],
      ),
    remove: (path) =>
      mutate(
        (effects) =>
          locks.hold([projectPath(path)], async () => {
            const absolute = projectPath(path);
            // The entry itself is removed, link or not; only the way to it must stay inside.
            await confiner()(absolute, false);
            // Listed before the removal: afterwards there is nothing left to list.
            const inside = await filesInside(absolute);
            await filesystem.remove(absolute);
            effects.removed.push(path, ...inside);
          }),
        [path],
      ),
    // Both names are held while the destination is checked and the rename runs, so of two moves
    // to one free name the second finds it taken and leaves its source where it was.
    move: (from, to) =>
      mutate(
        (effects) =>
          locks.hold([projectPath(from), projectPath(to)], async () => {
            const source = projectPath(from);
            const destination = projectPath(to);
            // Refused before anything is created: a folder cannot go inside itself.
            if (isSameOrInside(to, from)) throw new MoveIntoItselfError(from, to);
            const confine = confiner();
            await Promise.all([confine(source, false), confine(destination, false)]);
            if (!(await found(source))) throw new Error(`"${from}" does not exist`);
            const inside = await filesInside(source);
            await filesystem.mkdirp(parentOf(destination));
            // The last look before the rename: Waffle's rename would replace what is there.
            if (await found(destination)) throw new DestinationExistsError(to);
            try {
              await filesystem.move(source, destination);
            } catch (error) {
              remember(error);
              throw error;
            }
            // One operation id for the folder and every file listed with it: a reader applies the
            // operation once, and can tell it apart from a later move between the same paths.
            moveOperations += 1;
            const operation = moveOperations;
            effects.moves.push(
              { from, to, operation },
              ...inside.map((file) => ({ from: file, to: rebase(file, from, to), operation })),
            );
          }),
        [from, to],
      ),
    upload: (items, directory) => upload(items, directory),
    async exportZip() {
      const entries: { path: string; bytes: Uint8Array }[] = [];
      await inBatches(await projectFiles(), async (path) => {
        const bytes = await readConfined(path);
        // A file removed while it was being read is simply not in the archive.
        if (bytes) entries.push({ path, bytes });
      });
      entries.sort((a, b) => (a.path < b.path ? -1 : 1));
      return createZipBlob(entries);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    revoke(reason) {
      revoked = reason;
      setWritable(false);
      persistence.stop(reason);
    },
    dispose() {
      clearTimeout(timer);
      listeners.clear();
      stopWatching();
      sizeOf?.dispose();
    },
  };
}
