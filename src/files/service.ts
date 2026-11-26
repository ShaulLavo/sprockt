// The one door between the UI and a workspace's files. Paths are project-relative: plain
// `a/b.txt` names, never absolute, never with `.` or `..`. A path that is not, or that reaches
// outside the project through a symbolic link, is refused with ProjectPathError.
import type { Accessor } from "solid-js";
import type { Runtime } from "waffle";
import type { SaveState } from "./persistence";
import { createProjectFiles, type ProjectFiles } from "./project-files";
import type { DirEntry } from "./tree";
import { createSizeLookup } from "./size";
import { watchFilesystem } from "./watch";

export type { SaveState };
export type { DirEntry } from "./tree";

/** A file or directory to put in the project. Without `data` it is an (empty) directory. */
export interface UploadItem {
  /** Relative to the directory being uploaded into, such as "images/logo.png". */
  readonly path: string;
  readonly data?: Blob;
}

export interface UploadResult {
  /** Project paths of the files and directories that were written. */
  readonly written: string[];
  /** Items left out: unsafe paths, and anything inside `node_modules` or `.git`. */
  readonly skipped: number;
}

/** What changed since the last notification. Delivered after changes are coalesced over 50 ms. */
export interface FileChange {
  /** Project paths that were created, changed or removed. Empty after a `reset`. */
  readonly paths: readonly string[];
  /** Events may have been lost (watcher overflow or reopen): treat everything as changed. */
  readonly reset: boolean;
  /**
   * Renames and moves made through `FileService.move`, in the order they happened, so open tabs
   * can follow their file. Moving a folder lists the folder itself, then every file inside it,
   * each with its old and new path. `operation` is the same for one `move` call and grows with
   * every call: apply the first entry of an operation once, the others describe it.
   */
  readonly moves: readonly { readonly from: string; readonly to: string; readonly operation: number }[];
  /**
   * Paths deleted through `FileService.remove`. Deleting a folder lists the folder itself and every
   * file that was inside it, so no open buffer is left attached to a path that no longer exists.
   * Changes made by the shell or another tab are not listed here: they arrive in `paths`.
   */
  readonly removed: readonly string[];
}

/** `written: false` means the file no longer held the expected text; `current` is what it holds. */
export type WriteOutcome =
  | { readonly written: true }
  | { readonly written: false; readonly current: string | undefined };

export interface FileService {
  /** Project files, without node_modules and .git. */
  list(): Promise<string[]>;
  /**
   * The entries directly inside a directory, folders first, or undefined when it does not exist
   * (or is a file). Unlike `list` it includes empty directories and `node_modules` / `.git`.
   * One level at a time keeps big trees cheap.
   */
  readdir(path: string): Promise<DirEntry[] | undefined>;
  read(path: string): Promise<string | undefined>;
  readBytes(path: string): Promise<Uint8Array | undefined>;
  /** A file's size in bytes, without reading it; undefined when it is missing or not a file. */
  size(path: string): Promise<number | undefined>;
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
  /**
   * Creates a file that does not exist yet (empty unless `content` is given). Throws
   * `DestinationExistsError` instead of replacing anything, even when the name was taken a moment
   * ago by the shell or another tab.
   */
  create(path: string, content?: string | Uint8Array): Promise<void>;
  /**
   * Moves or renames a file or directory. Throws `DestinationExistsError` when the destination
   * exists, and `MoveIntoItselfError` for a destination inside the source, before anything is
   * changed. Waffle has no rename that refuses to replace, so the destination is checked just
   * before the rename; a name taken in the instants between the two can still be replaced.
   */
  move(from: string, to: string): Promise<void>;
  /**
   * Puts files and folders from outside (a drop, a file picker) into `directory` ("" is the
   * project root), creating folders as needed and replacing files that already exist. One change
   * notification for the whole batch.
   */
  upload(items: readonly UploadItem[], directory: string): Promise<UploadResult>;
  /** The whole project as a ZIP, without node_modules and .git. */
  exportZip(): Promise<Blob>;
  /** Like `revision`, but says what changed, so a view can refresh only that. Returns an unsubscribe. */
  subscribe(listener: (change: FileChange) => void): () => void;
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
  return createProjectFiles(
    runtime.filesystem,
    (onChange) => watchFilesystem(runtime, onChange),
    createSizeLookup(runtime),
  );
}
