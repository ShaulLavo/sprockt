/**
 * The minimal file-system surface the services need. Names follow Waffle's
 * filesystem (`@waffle-os/runtime`: `readFile`, `writeFile`, `readdir`, `stat`,
 * and `kind: "file" | "directory" | "symlink"`), but every call is async and
 * path based so the same code runs against Waffle, OPFS or an in-memory map.
 *
 * Paths are POSIX style and relative to the workspace root, without a leading
 * slash: `src/main.ts`. The root itself is `""`.
 */
export type EntryKind = "file" | "directory" | "symlink";

export interface FsStat {
  readonly kind: EntryKind;
  readonly size: number;
  /** Unix permission bits (`0o644`, `0o755`). Absent means unsupported. */
  readonly mode?: number;
}

export interface FsDirent {
  readonly name: string;
  readonly kind: EntryKind;
}

export interface WriteFileOptions {
  readonly mode?: number;
}

export interface ProjectFs {
  /** The file's bytes, or `undefined` when it does not exist. */
  readFile(path: string): Promise<Uint8Array | undefined>;
  /** Creates or replaces a file. Parent directories must exist (see `mkdir`). */
  writeFile(path: string, bytes: Uint8Array, options?: WriteFileOptions): Promise<void>;
  /** Directory entries in no particular order. Throws when `path` is not a directory. */
  readdir(path: string): Promise<readonly FsDirent[]>;
  /** `undefined` when nothing exists at `path`. */
  stat(path: string): Promise<FsStat | undefined>;
  /** Creates the directory and any missing parents, like `mkdir -p`. */
  mkdir(path: string): Promise<void>;
}

/** One regular file of a workspace snapshot, as importers produce and exporters consume. */
export interface FileEntry {
  readonly path: string;
  readonly bytes: Uint8Array;
  /** Unix permission bits; `0o644` when absent. */
  readonly mode?: number;
}

export const DEFAULT_FILE_MODE = 0o644;
