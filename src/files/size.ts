// File sizes without reading the files. Waffle's page-level filesystem has no stat, so this asks
// the filesystem worker directly over a client of its own (as the watcher does): resolve the
// path from a root handle, then stat the handle. Both are plain asynchronous reads.
import type { Runtime } from "waffle";
import { FilesystemClient } from "waffle/fs/client";

export interface SizeLookup {
  /** Size in bytes of the file at an absolute path; undefined when it is missing or not a file. */
  size(absolute: string): Promise<number | undefined>;
  dispose(): void;
}

interface Resolved {
  readonly node: number | undefined;
}

interface Stat {
  readonly kind: string;
  readonly size: number;
}

export function createSizeLookup(runtime: Runtime): SizeLookup {
  let client: FilesystemClient | undefined;
  let root: Promise<number> | undefined;

  async function size(absolute: string): Promise<number | undefined> {
    client ??= new FilesystemClient(runtime.filesystem.fork());
    const connection = client;
    root ??= connection.asyncCall("preopen", ["/"]) as Promise<number>;
    const relative = absolute.replace(/^\/+/, "");
    const resolved = (await connection.asyncCall("resolve", [await root, relative, true, false])) as
      | Resolved
      | number;
    if (typeof resolved === "number" || resolved.node === undefined) return undefined;
    const stat = (await connection.asyncCall("stat", [resolved.node])) as Stat;
    return stat.kind === "file" ? stat.size : undefined;
  }

  return {
    size,
    dispose() {
      client?.dispose();
      client = undefined;
      root = undefined;
    },
  };
}
