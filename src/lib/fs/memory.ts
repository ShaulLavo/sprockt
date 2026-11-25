import { joinPath, normalizePath, parentPath } from "./path.ts";
import {
  DEFAULT_FILE_MODE,
  type FsDirent,
  type FsStat,
  type ProjectFs,
  type WriteFileOptions,
} from "./types.ts";

interface MemoryFile {
  bytes: Uint8Array;
  mode: number;
}

/**
 * An in-memory `ProjectFs`. Used by tests and as a staging area before files
 * reach the runtime's real filesystem.
 */
export class MemoryFs implements ProjectFs {
  readonly #files = new Map<string, MemoryFile>();
  readonly #dirs = new Set<string>([""]);

  async readFile(path: string): Promise<Uint8Array | undefined> {
    return this.#files.get(this.#key(path))?.bytes;
  }

  async writeFile(path: string, bytes: Uint8Array, options?: WriteFileOptions): Promise<void> {
    const key = this.#key(path);
    if (this.#dirs.has(key)) throw new Error(`EISDIR: ${path}`);
    if (!this.#dirs.has(parentPath(key))) throw new Error(`ENOENT: no parent directory for ${path}`);
    this.#files.set(key, { bytes, mode: options?.mode ?? DEFAULT_FILE_MODE });
  }

  async readdir(path: string): Promise<readonly FsDirent[]> {
    const dir = this.#key(path);
    if (!this.#dirs.has(dir)) throw new Error(`ENOTDIR: ${path}`);
    const entries: FsDirent[] = [];
    for (const child of this.#dirs) {
      if (child !== "" && child !== dir && parentPath(child) === dir) {
        entries.push({ name: child.slice(dir === "" ? 0 : dir.length + 1), kind: "directory" });
      }
    }
    for (const file of this.#files.keys()) {
      if (parentPath(file) === dir) {
        entries.push({ name: file.slice(dir === "" ? 0 : dir.length + 1), kind: "file" });
      }
    }
    return entries;
  }

  async stat(path: string): Promise<FsStat | undefined> {
    const key = this.#key(path);
    if (this.#dirs.has(key)) return { kind: "directory", size: 0, mode: 0o755 };
    const file = this.#files.get(key);
    if (!file) return undefined;
    return { kind: "file", size: file.bytes.byteLength, mode: file.mode };
  }

  async mkdir(path: string): Promise<void> {
    const key = this.#key(path);
    let current = "";
    for (const segment of key.split("/")) {
      if (segment === "") continue;
      current = joinPath(current, segment);
      if (this.#files.has(current)) throw new Error(`EEXIST: ${current} is a file`);
      this.#dirs.add(current);
    }
  }

  #key(path: string): string {
    const key = normalizePath(path);
    if (key === undefined) throw new Error(`EINVAL: ${path}`);
    return key;
  }
}
