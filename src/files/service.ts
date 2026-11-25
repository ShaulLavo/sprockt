// The one door between the UI and a workspace's files. Paths are project-relative: plain
// `a/b.txt` names, never absolute, never with `.` or `..`. A path that is not, or that reaches
// outside the project through a symbolic link, is refused with ProjectPathError.
import type { Accessor } from "solid-js";
import type { Runtime } from "waffle";
import type { SaveState } from "./persistence";
import { createProjectFiles, type ProjectFiles } from "./project-files";
import { watchFilesystem } from "./watch";

export type { SaveState };

/** `written: false` means the file no longer held the expected text; `current` is what it holds. */
export type WriteOutcome =
  | { readonly written: true }
  | { readonly written: false; readonly current: string | undefined };

export interface FileService {
  /** Project files, without node_modules and .git. */
  list(): Promise<string[]>;
  read(path: string): Promise<string | undefined>;
  readBytes(path: string): Promise<Uint8Array | undefined>;
  /** Creates missing parent directories. */
  write(path: string, content: string | Uint8Array): Promise<void>;
  /**
   * Writes only when the file still holds `expected` (undefined: still does not exist), so an
   * edit made meanwhile by the shell or another tab is not overwritten unseen. The check and
   * the write are two steps, not one atomic step: Waffle has no conditional write yet.
   */
  writeIfUnchanged(path: string, content: string, expected: string | undefined): Promise<WriteOutcome>;
  /** Writes a whole file set, such as a template or an imported repository. */
  writeMany(files: Readonly<Record<string, string | Uint8Array>>): Promise<void>;
  mkdir(path: string): Promise<void>;
  /** Removes a file or a directory with everything in it. */
  remove(path: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
  /** Changes whenever the project's files may have changed; read it to re-run a listing. */
  readonly revision: Accessor<number>;
  /**
   * `saved`: everything written so far, by anyone, has reached IndexedDB. `saving` from the
   * moment a write starts. `failed`: a flush failed, or another tab took the workspace.
   */
  readonly saveState: Accessor<SaveState>;
  /** Resolves when everything written so far is saved. Rejects when saving failed. */
  saved(): Promise<void>;
  /** False once another tab took the workspace over: every write is refused from then on. */
  readonly writable: Accessor<boolean>;
  dispose(): void;
}

export function createFileService(runtime: Runtime): ProjectFiles {
  return createProjectFiles(runtime.filesystem, (onChange) => watchFilesystem(runtime, onChange));
}
