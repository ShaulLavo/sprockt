// Between a live workspace and a share link: snapshot the files for a link, and turn a link back
// into the file set of a new workspace.
import type { FileService } from "../files/service";
import { COPY, fill } from "../importer/copy";
import { isMetaPath, readMetaFile } from "../importer/metadata";
import type { FileEntry } from "../lib/fs/types";
import type { WorkspaceSession } from "../workspace/session";
import {
  applySnapshot,
  decodeShareFragment,
  diffSnapshot,
  encodeShareFragment,
  type EncodeShareResult,
  type ShareSnapshot,
} from "./share";
import { BLANK_TEMPLATE, templateFiles } from "./templates";

/** The share page's path; the snapshot rides in the fragment, which never reaches a server. */
export const SHARE_PATH = "/s";

/** What a share link is made from: the project's files, and the template it started from. */
export interface ShareSource {
  readonly files: Pick<FileService, "list" | "readBytes">;
  /** The template id from the workspace's metadata, if it has one. */
  readonly template: () => Promise<string | undefined>;
}

/** The share source of an open workspace; its metadata is read from the filesystem root. */
export function sessionShareSource(session: Pick<WorkspaceSession, "files" | "runtime">): ShareSource {
  return {
    files: session.files,
    template: async () => (await readMetaFile(session.runtime.filesystem))?.template,
  };
}

/** The project's files as a snapshot against its template. */
export async function snapshotWorkspace(source: ShareSource): Promise<ShareSnapshot> {
  const paths = (await source.files.list()).filter((path) => !isMetaPath(path));
  const read = await Promise.all(
    paths.map(async (path) => {
      const bytes = await source.files.readBytes(path);
      return bytes ? [{ path, bytes }] : [];
    }),
  );
  const entries: FileEntry[] = read.flat();
  const template = await source.template();
  const base = template ? await templateFiles(template) : undefined;
  if (template && base) return diffSnapshot(template, base, entries);
  return { templateId: BLANK_TEMPLATE, files: entries, deleted: [] };
}

export type ShareLinkResult =
  | (EncodeShareResult & { readonly ok: false })
  | { readonly ok: true; readonly url: string };

/** A share link for the workspace, or why there cannot be one. */
export async function createShareLink(source: ShareSource, origin: string): Promise<ShareLinkResult> {
  const encoded = await encodeShareFragment(await snapshotWorkspace(source));
  if (!encoded.ok) return encoded;
  return { ok: true, url: `${origin}${SHARE_PATH}#${encoded.fragment}` };
}

export type ShareOutcome =
  | { readonly kind: "link"; readonly url: string }
  | { readonly kind: "error"; readonly message: string };

/**
 * What the Share control shows: a link, or a sentence saying why there is none. Never rejects:
 * a failed read or encode becomes an error the visitor sees and can retry.
 */
export async function prepareShare(source: ShareSource, origin: string): Promise<ShareOutcome> {
  try {
    const result = await createShareLink(source, origin);
    if (result.ok) return { kind: "link", url: result.url };
    if (result.reason === "too-big") return { kind: "error", message: COPY.errors.shareLinkTooBig };
    return { kind: "error", message: fill(COPY.errors.shareFailed, { message: result.path }) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "error", message: fill(COPY.errors.shareFailed, { message }) };
  }
}

export type RestoredShare =
  | {
      readonly ok: true;
      readonly template: string;
      readonly files: Readonly<Record<string, Uint8Array>>;
    }
  | { readonly ok: false };

/** The complete file set a share fragment describes. */
export async function restoreShare(fragment: string): Promise<RestoredShare> {
  const decoded = await decodeShareFragment(fragment);
  if (!decoded.ok) return { ok: false };
  const { snapshot } = decoded;
  const base = await templateFiles(snapshot.templateId);
  if (!base) return { ok: false };
  const files = applySnapshot(base, snapshot).filter((file) => !isMetaPath(file.path));
  return {
    ok: true,
    template: snapshot.templateId,
    files: Object.fromEntries(files.map((file) => [file.path, file.bytes])),
  };
}
