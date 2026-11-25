import { joinPath, parentPath } from "./path.ts";
import type { FileEntry, ProjectFs } from "./types.ts";

/** Directory names skipped by default when reading a workspace for export or sharing. */
export const DEFAULT_EXCLUDED_DIRS: readonly string[] = ["node_modules", ".git"];

export interface CollectOptions {
  /** Directory names skipped at any depth. Defaults to `DEFAULT_EXCLUDED_DIRS`. */
  readonly excludeDirs?: readonly string[];
}

/**
 * Reads every regular file under `root` into entries whose paths are relative
 * to `root`, sorted by path. Symlinks are skipped.
 */
export async function collectFiles(
  fs: ProjectFs,
  root = "",
  options: CollectOptions = {},
): Promise<FileEntry[]> {
  const excluded = new Set(options.excludeDirs ?? DEFAULT_EXCLUDED_DIRS);
  const entries = await collectDirectory(fs, root, "", excluded);
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Reads one directory's files and subdirectories in parallel. */
async function collectDirectory(
  fs: ProjectFs,
  root: string,
  dir: string,
  excluded: ReadonlySet<string>,
): Promise<FileEntry[]> {
  const dirents = await fs.readdir(joinPath(root, dir));
  const nested = await Promise.all(
    dirents.map((dirent): Promise<FileEntry[]> => {
      const path = joinPath(dir, dirent.name);
      if (dirent.kind === "file") return readEntry(fs, root, path).then((entry) => [entry]);
      if (dirent.kind === "directory" && !excluded.has(dirent.name)) {
        return collectDirectory(fs, root, path, excluded);
      }
      return Promise.resolve([]);
    }),
  );
  return nested.flat();
}

async function readEntry(fs: ProjectFs, root: string, path: string): Promise<FileEntry> {
  const full = joinPath(root, path);
  const [bytes, stat] = await Promise.all([fs.readFile(full), fs.stat(full)]);
  if (!bytes) throw new Error(`ENOENT: ${full} disappeared while reading`);
  return { path, bytes, mode: stat?.mode };
}

/** Writes entries under `root`, creating each parent directory once. */
export async function writeFiles(fs: ProjectFs, entries: Iterable<FileEntry>, root = ""): Promise<void> {
  const list = Array.from(entries);
  const dirs = new Set(list.map((entry) => parentPath(joinPath(root, entry.path))));
  await Promise.all(Array.from(dirs, (dir) => fs.mkdir(dir)));
  await Promise.all(
    list.map((entry) => fs.writeFile(joinPath(root, entry.path), entry.bytes, { mode: entry.mode })),
  );
}
