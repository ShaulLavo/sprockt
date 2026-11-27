// `/.sprockt/workspace.json`: what a workspace is and where it came from, kept inside the
// workspace so there is no second database to keep in step (ARCHITECTURE.md "State"). The
// landing slice owns the name, template and last-opened fields; this slice writes `source`.
import type { Command, ProjectDetection } from "./detect/detect";

/**
 * Where the metadata lives: on the workspace filesystem's root, outside the project
 * (`/workspace`), so it never appears in the explorer, ZIP exports, share links or git, and
 * FileService never touches it. Read and written through `runtime.filesystem`.
 */
export const WORKSPACE_META_DIR = "/.sprockt";
export const WORKSPACE_META_PATH = `${WORKSPACE_META_DIR}/workspace.json`;
const PROJECT_META_DIR = ".sprockt";

/**
 * Whether a project path is a `.sprockt` folder, or something in it, or a file of that name.
 * Imported and shared files at these paths are dropped as a guard: they belong to the source.
 */
export function isMetaPath(path: string): boolean {
  return path === PROJECT_META_DIR || path.startsWith(`${PROJECT_META_DIR}/`);
}

/** The filesystem calls metadata needs; `runtime.filesystem` provides them. */
export interface MetaFilesystem {
  readFile(path: string): Promise<Uint8Array | undefined>;
  writeFile(path: string, content: string | Uint8Array): Promise<unknown>;
  mkdirp(path: string): Promise<unknown>;
  flush(): Promise<unknown>;
}

const metaDecoder = new TextDecoder();

export async function readMetaFile(filesystem: MetaFilesystem): Promise<WorkspaceMeta | undefined> {
  const bytes = await filesystem.readFile(WORKSPACE_META_PATH);
  return parseMeta(bytes && metaDecoder.decode(bytes));
}

/** Writes the metadata and flushes it, so it survives a reload as soon as this returns. */
export async function writeMetaFile(filesystem: MetaFilesystem, meta: WorkspaceMeta): Promise<void> {
  await filesystem.mkdirp(WORKSPACE_META_DIR);
  await filesystem.writeFile(WORKSPACE_META_PATH, serializeMeta(meta));
  await filesystem.flush();
}

export type WorkspaceSource =
  | {
      readonly kind: "github";
      readonly owner: string;
      readonly repo: string;
      readonly ref: string;
      readonly subdir: string;
      readonly commit?: string;
    }
  | { readonly kind: "share"; readonly template: string };

/**
 * Set while a workspace is still being written (an import, a share link, a template seed) and
 * cleared as the very last step. A workspace that still has it was cut off: the landing page
 * offers Retry and Delete. Sprockt never deletes such a workspace on its own.
 */
export const INCOMPLETE = "importing";

export interface WorkspaceMeta {
  readonly name: string;
  /** True only when Sprockt auto-assigned a generic placeholder name (e.g. blank/shared fallback). */
  readonly defaultName?: boolean;
  /** The template the workspace started from, when it did. */
  readonly template?: string;
  readonly source?: WorkspaceSource;
  /** ISO time; the same field names as the landing slice's metadata. */
  readonly created: string;
  readonly lastOpened?: string;
  /** `INCOMPLETE` until the workspace's files are all written. */
  readonly state?: typeof INCOMPLETE;
  /** What the importer detected, shown to the user. */
  readonly detected?: Pick<ProjectDetection, "framework" | "packageManager" | "devScript" | "port">;
  /**
   * Install and dev-server commands still to run after an import. Removed by the first
   * after-import handler that takes it, so it runs once across tabs and reloads.
   */
  readonly pendingImport?: ImportPlan;
}

export interface ImportPlan {
  readonly install: Command | undefined;
  readonly dev: Command | undefined;
  readonly port: number | undefined;
}

export function serializeMeta(meta: WorkspaceMeta): string {
  return `${JSON.stringify(meta, null, 2)}\n`;
}

/** The parsed metadata, or `undefined` when the file is missing or not an object with a name. */
export function parseMeta(text: string | undefined): WorkspaceMeta | undefined {
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    return typeof (value as { name?: unknown }).name === "string" ? (value as WorkspaceMeta) : undefined;
  } catch {
    return undefined;
  }
}
