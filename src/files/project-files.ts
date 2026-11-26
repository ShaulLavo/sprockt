// FileService on top of a filesystem and a watcher, with nothing browser-specific in it, so the
// rules it enforces (the project boundary, what "saved" means) are tested without a runtime.
import type { SizeLookup } from "./size";
import { createSignal } from "../lib/reactive";
import { createZipBlob } from "../lib/zip/zip";
import {
  isInsideProject,
  PROJECT_ROOT,
  projectPath,
  ProjectPathError,
  projectRelative,
} from "../workspace/paths";
import { DestinationExistsError, FolderGoneError, MoveIntoItselfError } from "./errors";
import { isSameOrInside, joinPath, rebase, safeRelativePath } from "./paths";
import { ancestorsOf, localPathLocks, type LockRequest, type PathLocks } from "./path-locks";
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
  /** Paths written or created so far: published even if a bulk operation fails partway. */
  readonly partial: string[];
}

const emptyPending = (): Pending => ({ paths: new Set(), moves: [], removed: new Set(), reset: false });

async function inBatches<T>(
  items: readonly T[],
  work: (item: T, isAborted: () => boolean) => Promise<void>,
): Promise<void> {
  let aborted = false;
  let failed = false;
  let firstError: unknown;
  const fail = (error: unknown) => {
    aborted = true;
    if (failed) return;
    failed = true;
    firstError = error;
  };
  const runOne = async (item: T) => {
    if (aborted) return;
    try {
      await work(item, () => aborted);
    } catch (error) {
      fail(error);
      throw error;
    }
  };
  for (let start = 0; start < items.length; start += BATCH) {
    if (aborted) break;
    // Each batch settles completely before the next starts or an error escapes (and unlocks).
    // oxlint-disable-next-line no-await-in-loop
    const outcomes = await Promise.allSettled(items.slice(start, start + BATCH).map(runOne));
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") fail(outcome.reason);
    }
  }
  if (failed) throw firstError;
}

const parentOf = (absolute: string) => absolute.slice(0, absolute.lastIndexOf("/"));
type Lookup = (path: string) => Promise<ResolvedEntry | undefined>;

/** Where an entry really is; see `createInspector`. */
interface Located {
  readonly real: string;
  readonly exists: boolean;
  /** The real path of the nearest existing directory above the entry. */
  readonly base: string;
  /** Canonical paths of symbolic links traversed on the way to this entry, sorted. */
  readonly links: readonly string[];
}

/** Whether `path` lies strictly inside `directory` ("" is the filesystem root). */
const isBelow = (path: string, directory: string) => path.startsWith(`${directory}/`);

const sameStrings = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((item, index) => item === b[index]);

/** The deepest directory that holds every one of `paths` (absolute, normalized). */
function commonDirectory(paths: readonly string[]): string {
  const [first, ...rest] = paths.map(parentOf);
  if (first === undefined) return PROJECT_ROOT;
  return rest.reduce((common, path) => {
    let shared = common;
    while (shared !== "" && path !== shared && !isBelow(path, shared)) shared = parentOf(shared);
    return shared;
  }, first);
}

/** Drops exclusive lock roots already covered by an ancestor root in the same request. */
function pruneExclusive(roots: readonly string[]): string[] {
  const sorted = Array.from(new Set(roots)).sort();
  const kept: string[] = [];
  for (const root of sorted) {
    if (kept.some((parent) => isBelow(root, parent))) continue;
    kept.push(root);
  }
  return kept;
}

/**
 * Plans locks for a bulk write: direct files share one folder lock, while any link-redirected
 * destinations get exclusive locks on their canonical destination(s) and shared locks on every
 * traversed link entry and ancestor.
 */
function planBulkLocks(places: readonly Located[]): LockRequest {
  const groups = new Map<string, string[]>();
  const shared = new Set<string>();
  for (const place of places) {
    const key = place.links.join("\0");
    const bucket = groups.get(key);
    if (bucket) bucket.push(place.real);
    else groups.set(key, [place.real]);
    for (const link of place.links) {
      shared.add(link);
      for (const ancestor of ancestorsOf(link)) shared.add(ancestor);
    }
  }
  const rawExclusive = Array.from(groups.values(), (reals) =>
    reals.length === 1 ? reals[0]! : commonDirectory(reals),
  );
  const exclusive = pruneExclusive(rawExclusive);
  for (const root of exclusive) {
    for (const ancestor of ancestorsOf(root)) shared.add(ancestor);
  }
  return { exclusive, shared: Array.from(shared) };
}

/** Matches Waffle's symlink expansion cap (`walkTree` in `waffle/fs/memory.ts` rejects at 40). */
const MAX_LINK_EXPANSIONS = 40;

/**
 * Memoized path inspector for one planning or revalidation pass: resolves canonical destinations
 * and collects every symbolic link entry traversed along the way. Fails closed if a link target
 * is missing, cycles, or exceeds the resolver's expansion cap so no partial lock set is ever used.
 */
function createInspector(resolve: Lookup): (absolute: string) => Promise<Located> {
  const resolved = new Map<string, Promise<ResolvedEntry | undefined>>();
  const dirs = new Map<string, Promise<Located>>();

  const lookup: Lookup = (path) => {
    const known = resolved.get(path) ?? resolve(path);
    resolved.set(path, known);
    return known;
  };

  async function collectLinks(
    entry: ResolvedEntry,
    links: Set<string>,
    visiting: Set<string>,
    done: Set<string>,
  ): Promise<void> {
    if (entry.kind !== "symlink") return;
    if (visiting.has(entry.path)) throw new Error("ELOOP: too many levels of symbolic links");
    if (done.has(entry.path)) return;
    if (links.size >= MAX_LINK_EXPANSIONS) throw new Error("ELOOP: too many levels of symbolic links");
    if (!entry.target) throw new Error(`Cannot resolve symbolic link target for ${entry.path}`);
    links.add(entry.path);
    visiting.add(entry.path);
    try {
      const next = entry.target.startsWith("/") ? entry.target : `${parentOf(entry.path)}/${entry.target}`;
      const parts = next.split("/").filter(Boolean);
      const steps = await Promise.all(
        parts.map((_, index) => lookup(`/${parts.slice(0, index + 1).join("/")}`)),
      );
      for (const step of steps) {
        if (step?.kind !== "symlink") continue;
        // oxlint-disable-next-line no-await-in-loop -- depth-first so `visiting` accurately tracks cycles
        await collectLinks(step, links, visiting, done);
      }
      done.add(entry.path);
    } finally {
      visiting.delete(entry.path);
    }
  }

  function inspectDir(directory: string): Promise<Located> {
    const cached = dirs.get(directory);
    if (cached) return cached;
    const promise = computeDir(directory);
    dirs.set(directory, promise);
    return promise;
  }

  async function computeDir(directory: string): Promise<Located> {
    if (directory === "") return { real: "", exists: true, base: "", links: [] };
    const parent = await inspectDir(parentOf(directory));
    const name = directory.slice(directory.lastIndexOf("/") + 1);
    if (!parent.exists) {
      return { real: `${parent.real}/${name}`, exists: false, base: parent.base, links: parent.links };
    }
    const entry = await lookup(directory);
    if (!entry) {
      return { real: `${parent.real}/${name}`, exists: false, base: parent.real, links: parent.links };
    }
    if (entry.kind !== "symlink") {
      return { real: entry.path, exists: true, base: parentOf(entry.path), links: parent.links };
    }
    const links = new Set(parent.links);
    await collectLinks(entry, links, new Set(), new Set(parent.links));
    return { real: entry.path, exists: true, base: parentOf(entry.path), links: Array.from(links).sort() };
  }

  return async function inspect(absolute: string): Promise<Located> {
    if (absolute === "") return { real: "", exists: true, base: "", links: [] };
    const parent = await inspectDir(parentOf(absolute));
    const name = absolute.slice(absolute.lastIndexOf("/") + 1);
    if (!parent.exists) {
      return { real: `${parent.real}/${name}`, exists: false, base: parent.base, links: parent.links };
    }
    const entry = await lookup(absolute);
    if (entry) return { real: entry.path, exists: true, base: parentOf(entry.path), links: parent.links };
    return { real: `${parent.real}/${name}`, exists: false, base: parent.real, links: parent.links };
  };
}

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
  const editListeners = new Set<(paths: readonly string[]) => void>();
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

  function publishEffects(effects: Partial<Effects>, edited: readonly string[]): void {
    persistence.touch();
    changedProject(effects);
    // Told at once and apart from the watcher's news: this change was made through the service.
    for (const listener of editListeners) listener(edited);
  }

  /** Runs a change: refused when storage is gone, `saving` from now until it is flushed. */
  async function mutate<T>(change: (effects: Effects) => Promise<T>, paths: readonly string[]): Promise<T> {
    if (revoked) throw revoked;
    const end = persistence.begin();
    const effects: Effects = { paths: Array.from(paths), moves: [], removed: [], partial: [] };
    try {
      const result = await change(effects);
      publishEffects(effects, effects.paths);
      return result;
    } catch (error) {
      remember(error);
      if (effects.partial.length > 0) publishEffects({ paths: effects.partial }, effects.partial);
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

  /**
   * Runs a change on `targets` (absolute paths) under their locks, across every tab: each target's
   * real path exclusively, every directory above it and every traversed symbolic link shared.
   * Under the locks the targets are inspected again. A directory that held a target when the
   * change began and is gone now was moved or deleted by another tab: the change fails instead of
   * recreating it. A target whose real destination or traversed links changed is tried once more.
   */
  async function locked<T>(
    targets: readonly string[],
    change: () => Promise<T>,
    options: { readonly bulk?: boolean; readonly first?: readonly Located[] } = {},
  ): Promise<T> {
    const before = await Promise.all(targets.map(createInspector(found)));
    const origin = options.first ?? before;
    const request: LockRequest = options.bulk
      ? planBulkLocks(before)
      : {
          exclusive: before.map((place) => place.real),
          shared: targets
            .flatMap(ancestorsOf)
            .concat(
              before.flatMap((place) =>
                ancestorsOf(place.real).concat(place.links, place.links.flatMap(ancestorsOf)),
              ),
            ),
        };
    const outcome = await locks.hold(request, async () => {
      const now = await Promise.all(targets.map(createInspector(found)));
      const gone = now.findIndex((place, index) => isBelow(origin[index]!.base, place.base));
      if (gone >= 0) throw new FolderGoneError(projectRelative(targets[gone]!) ?? targets[gone]!);
      const moved = now.some(
        (place, index) =>
          place.real !== before[index]!.real || !sameStrings(place.links, before[index]!.links),
      );
      if (moved) return undefined;
      return { value: await change() };
    });
    if (outcome) return outcome.value;
    if (options.first) throw new Error("A symbolic link changed during this file operation. Try again.");
    return locked(targets, change, { bulk: options.bulk, first: origin });
  }

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

  async function uploadEntry(
    item: { readonly path: string; readonly data?: Blob },
    isAborted: () => boolean,
    effects: Effects,
  ): Promise<void> {
    // The bytes are read first and the links checked afterwards, with a fresh check per
    // entry: the check must describe the filesystem as it is when the write happens.
    const bytes = item.data && new Uint8Array(await item.data.arrayBuffer());
    if (isAborted()) return;
    const absolute = projectPath(item.path);
    await confiner()(absolute, true);
    if (isAborted()) return;
    if (bytes) {
      await filesystem.mkdirp(parentOf(absolute));
      effects.partial.push(item.path);
      await filesystem.writeFile(absolute, bytes);
      return;
    }
    effects.partial.push(item.path);
    await filesystem.mkdirp(absolute);
  }

  async function writeManyEntries(
    entries: readonly (readonly [string, string | Uint8Array])[],
    targets: readonly string[],
    effects: Effects,
  ): Promise<void> {
    const confine = confiner();
    // Links are checked for the whole set first, so a bad entry writes nothing.
    const checks = await Promise.allSettled(targets.map((absolute) => confine(absolute, true)));
    const failed = checks.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    if (failed) throw failed.reason;
    await inBatches(entries, async ([path, content], isAborted) => {
      if (isAborted()) return;
      const absolute = projectPath(path);
      await filesystem.mkdirp(parentOf(absolute));
      effects.partial.push(path);
      await filesystem.writeFile(absolute, content);
    });
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
    if (directory !== "") projectPath(directory);
    // Every path is checked before the first byte is written, as in writeMany.
    const targets = accepted.map(({ path }) => projectPath(path));
    if (accepted.length === 0) return { written: [], skipped };
    await mutate(
      (effects) =>
        locked(
          targets,
          () => inBatches(accepted, (item, isAborted) => uploadEntry(item, isAborted, effects)),
          { bulk: true },
        ),
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
    write: (path, content) =>
      mutate(() => locked([projectPath(path)], () => writeConfined(confiner(), path, content)), [path]),
    // The read, the comparison and the write hold the file's lock together, so a save in another
    // tab cannot land between them: the second of two overlapping saves sees the first and fails.
    // A save whose folder another tab moved or deleted meanwhile is a conflict with a deleted file.
    writeIfUnchanged: (path, content, expected) =>
      mutate(
        () =>
          locked([projectPath(path)], async (): Promise<WriteOutcome> => {
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
          }).catch((error: unknown): WriteOutcome => {
            if (error instanceof FolderGoneError) return { written: false, current: undefined };
            throw error;
          }),
        [path],
      ),
    async writeMany(files) {
      const entries = Object.entries(files);
      if (entries.length === 0) return;
      // Every path is checked before the first byte is written: a bad entry writes nothing.
      const targets = entries.map(([path]) => projectPath(path));
      await mutate(
        (effects) => locked(targets, () => writeManyEntries(entries, targets, effects), { bulk: true }),
        entries.map(([path]) => path),
      );
    },
    mkdir: (path) =>
      mutate(
        () =>
          locked([projectPath(path)], async () => {
            const absolute = projectPath(path);
            await confiner()(absolute, true);
            await filesystem.mkdirp(absolute);
          }),
        [path],
      ),
    create: (path, content = "") =>
      mutate(
        () =>
          locked([projectPath(path)], async () => {
            if (!(await writeExclusive(path, content))) throw new DestinationExistsError(path);
          }),
        [path],
      ),
    remove: (path) =>
      mutate(
        (effects) =>
          locked([projectPath(path)], async () => {
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
        (effects) => {
          // Refused before anything is created: a folder cannot go inside itself.
          if (isSameOrInside(to, from)) throw new MoveIntoItselfError(from, to);
          return locked([projectPath(from), projectPath(to)], async () => {
            const source = projectPath(from);
            const destination = projectPath(to);
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
          });
        },
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
    subscribeEdits(listener) {
      editListeners.add(listener);
      return () => editListeners.delete(listener);
    },
    revoke(reason) {
      revoked = reason;
      setWritable(false);
      persistence.stop(reason);
    },
    dispose() {
      clearTimeout(timer);
      listeners.clear();
      editListeners.clear();
      stopWatching();
      sizeOf?.dispose();
    },
  };
}
