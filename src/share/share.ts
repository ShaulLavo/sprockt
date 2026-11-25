import { normalizePath } from "../lib/fs/path.ts";
import { DEFAULT_FILE_MODE, type FileEntry } from "../lib/fs/types.ts";
import { githubImportPath } from "../importer/github/source.ts";
import {
  ByteLimitError,
  compressBytes,
  decodeUtf8,
  decompressBytes,
  fromBase64Url,
  textEncoder,
  toBase64Url,
} from "../lib/bytes.ts";

/**
 * A workspace small enough to live in a link: the template it started from,
 * plus the files changed or added since, and the template files deleted.
 */
export interface ShareSnapshot {
  readonly templateId: string;
  readonly files: readonly FileEntry[];
  readonly deleted: readonly string[];
}

export type EncodeShareResult =
  | { readonly ok: true; readonly fragment: string }
  | { readonly ok: false; readonly reason: "too-big"; readonly length: number; readonly maxLength: number }
  /** A file or deleted path that is not a clean workspace-relative path (`./a`, `../a`, `/a`, `""`). */
  | { readonly ok: false; readonly reason: "invalid-path"; readonly path: string };

export type DecodeShareResult =
  | { readonly ok: true; readonly snapshot: ShareSnapshot }
  | { readonly ok: false; readonly error: string };

export interface ShareOptions {
  /** Longest fragment produced, in characters. Links much longer than this break in chat apps and mail. */
  readonly maxLength?: number;
}

/** The fragment key: links look like `https://sprockt.dev/#share=<data>`. */
export const SHARE_KEY = "share";
export const DEFAULT_SHARE_MAX_LENGTH = 16 * 1024;
/** The longest fragment the decoder reads. `maxLength` above this is clamped, so every link we make decodes. */
export const MAX_SHARE_FRAGMENT_LENGTH = 1024 * 1024;
/** Largest uncompressed payload, enforced on both sides so a crafted link cannot exhaust memory. */
const MAX_DECODED_BYTES = 8 * 1024 * 1024;
const DAMAGED: DecodeShareResult = { ok: false, error: "This share link is damaged." };

/** Compact wire form: `[path, text]` for UTF-8 files, `[path, base64url, 1]` for binary, mode last when not 0o644. */
interface Payload {
  readonly t: string;
  readonly f: readonly (readonly [string, string, number?, number?])[];
  readonly d?: readonly string[];
}

/**
 * Encodes a snapshot as a URL fragment (without the leading `#`), or reports
 * that it is too big to share as a link.
 */
export async function encodeShareFragment(
  snapshot: ShareSnapshot,
  options: ShareOptions = {},
): Promise<EncodeShareResult> {
  const maxLength = Math.min(options.maxLength ?? DEFAULT_SHARE_MAX_LENGTH, MAX_SHARE_FRAGMENT_LENGTH);
  const badPath = snapshot.files
    .map((entry) => entry.path)
    .concat(snapshot.deleted)
    .find((path) => !isCleanPath(path));
  if (badPath !== undefined) return { ok: false, reason: "invalid-path", path: badPath };
  const payload: Payload = {
    t: snapshot.templateId,
    f: snapshot.files.map(encodeFile),
    ...(snapshot.deleted.length > 0 ? { d: snapshot.deleted } : {}),
  };
  const json = textEncoder.encode(JSON.stringify(payload));
  // The decoder refuses payloads over this size, so check before compressing: a highly
  // repetitive workspace can compress into a short link that would never open.
  if (json.byteLength > MAX_DECODED_BYTES) {
    return { ok: false, reason: "too-big", length: Number.POSITIVE_INFINITY, maxLength };
  }
  const fragment = `${SHARE_KEY}=${toBase64Url(await compressBytes(json, "deflate-raw"))}`;
  if (fragment.length > maxLength)
    return { ok: false, reason: "too-big", length: fragment.length, maxLength };
  return { ok: true, fragment };
}

/** A workspace path the decoder will accept unchanged: normalized, non-empty, inside the root. */
function isCleanPath(path: string): boolean {
  return path !== "" && normalizePath(path) === path;
}

function encodeFile(entry: FileEntry): readonly [string, string, number?, number?] {
  const mode = entry.mode ?? DEFAULT_FILE_MODE;
  const text = decodeUtf8(entry.bytes);
  const [content, binary] = text === undefined ? [toBase64Url(entry.bytes), 1] : [text, 0];
  if (mode !== DEFAULT_FILE_MODE) return [entry.path, content, binary, mode];
  return binary ? [entry.path, content, binary] : [entry.path, content];
}

/** Decodes a fragment from `encodeShareFragment`. Accepts it with or without `#`, or a whole URL. */
export async function decodeShareFragment(input: string): Promise<DecodeShareResult> {
  // Check the size before parsing or base64-decoding anything.
  if (input.length > MAX_SHARE_FRAGMENT_LENGTH * 2) return TOO_MUCH;
  const data = shareData(input);
  if (data === undefined) return { ok: false, error: "This link has no shared project in it." };
  if (SHARE_KEY.length + 1 + data.length > MAX_SHARE_FRAGMENT_LENGTH) return TOO_MUCH;
  const compressed = fromBase64Url(data);
  if (!compressed) return DAMAGED;
  const json = await inflate(compressed);
  if (typeof json !== "string") return json;
  return parsePayload(json);
}

const TOO_MUCH: DecodeShareResult = { ok: false, error: "This share link holds too much data." };

function shareData(input: string): string | undefined {
  const hash = input.includes("#") ? input.slice(input.indexOf("#") + 1) : input;
  const params = new URLSearchParams(hash);
  return params.get(SHARE_KEY) ?? undefined;
}

async function inflate(compressed: Uint8Array): Promise<string | DecodeShareResult> {
  try {
    const bytes = await decompressBytes(compressed, "deflate-raw", MAX_DECODED_BYTES);
    return decodeUtf8(bytes) ?? DAMAGED;
  } catch (error) {
    if (error instanceof ByteLimitError) return TOO_MUCH;
    return DAMAGED;
  }
}

/** Validates every field before using it: any JSON value can arrive here. */
function parsePayload(json: string): DecodeShareResult {
  const payload = parseJson(json);
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return DAMAGED;
  const { t, f, d = [] } = payload as Record<string, unknown>;
  if (typeof t !== "string" || !Array.isArray(f) || !Array.isArray(d)) return DAMAGED;
  const files = f.map(decodeFile);
  const deleted = d.map((path: unknown) =>
    typeof path === "string" && isCleanPath(path) ? path : undefined,
  );
  if (files.includes(undefined) || deleted.includes(undefined)) return DAMAGED;
  return {
    ok: true,
    snapshot: {
      templateId: t,
      files: files.filter((file): file is FileEntry => file !== undefined),
      deleted: deleted.filter((path): path is string => path !== undefined),
    },
  };
}

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

function decodeFile(item: unknown): FileEntry | undefined {
  if (!Array.isArray(item) || item.length < 2 || item.length > 4) return undefined;
  const [path, content, binary = 0, mode = DEFAULT_FILE_MODE] = item as unknown[];
  if (typeof path !== "string" || !isCleanPath(path) || typeof content !== "string") return undefined;
  if (
    (binary !== 0 && binary !== 1) ||
    !Number.isInteger(mode) ||
    (mode as number) < 0 ||
    (mode as number) > 0o7777
  ) {
    return undefined;
  }
  const bytes = binary === 1 ? fromBase64Url(content) : textEncoder.encode(content);
  return bytes ? { path, bytes, mode: mode as number } : undefined;
}

/** What changed between a template and the current workspace, as a share snapshot. */
export function diffSnapshot(
  templateId: string,
  template: readonly FileEntry[],
  current: readonly FileEntry[],
): ShareSnapshot {
  const base = new Map(template.map((entry) => [entry.path, entry]));
  const currentPaths = new Set(current.map((entry) => entry.path));
  const files = current.filter((entry) => !sameFile(base.get(entry.path), entry));
  const deleted = template.filter((entry) => !currentPaths.has(entry.path)).map((entry) => entry.path);
  return { templateId, files, deleted };
}

function sameFile(a: FileEntry | undefined, b: FileEntry): boolean {
  if (!a || a.bytes.byteLength !== b.bytes.byteLength) return false;
  if ((a.mode ?? DEFAULT_FILE_MODE) !== (b.mode ?? DEFAULT_FILE_MODE)) return false;
  return a.bytes.every((byte, index) => byte === b.bytes[index]);
}

/** The template's files with the snapshot's changes applied, sorted by path. */
export function applySnapshot(template: readonly FileEntry[], snapshot: ShareSnapshot): FileEntry[] {
  const files = new Map(template.map((entry) => [entry.path, entry]));
  for (const path of snapshot.deleted) files.delete(path);
  for (const entry of snapshot.files) files.set(entry.path, entry);
  return Array.from(files.values()).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** A link that imports (forks) a GitHub repository into a new workspace. */
export function forkFromGitHubUrl(
  origin: string,
  owner: string,
  repo: string,
  ref = "",
  subdir = "",
): string {
  return new URL(githubImportPath(owner, repo, ref, subdir), origin).toString();
}
