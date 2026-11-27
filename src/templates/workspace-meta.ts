// Metadata stored at /.sprockt/workspace.json inside each Waffle workspace.
// Pure parsing, validation, and formatting: no Solid, no DOM, no Waffle imports.
import {
  deriveGitHubWorkspaceName,
  INCOMPLETE,
  normalizeWorkspaceName,
  WORKSPACE_META_DIR,
  WORKSPACE_META_PATH,
  type WorkspaceMeta as ImporterWorkspaceMeta,
  type WorkspaceSource,
} from "../importer/metadata";

export {
  deriveGitHubWorkspaceName,
  INCOMPLETE,
  normalizeWorkspaceName,
  WORKSPACE_META_DIR,
  WORKSPACE_META_PATH,
};

const BLANK_DEFAULT_NAME = "workspace";
const metaTextDecoder = new TextDecoder();

export type WorkspaceState = typeof INCOMPLETE;

export interface WorkspaceMeta extends ImporterWorkspaceMeta {
  readonly template: string;
  readonly lastOpened: string;
  readonly source?: WorkspaceSource;
}

/** Reads a clean project name from a root `package.json` string or UTF-8 bytes. */
export function packageJsonName(raw: string | Uint8Array | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const text = typeof raw === "string" ? raw : metaTextDecoder.decode(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const name = (parsed as Record<string, unknown>).name;
  return typeof name === "string" ? normalizeWorkspaceName(name) : undefined;
}

/**
 * Derives a clean name when every uploaded item lives under a single top-level folder
 * (a folder picker pick or a dropped directory). Loose files return `undefined`.
 */
export function deriveUploadFolderName(
  items: readonly { readonly path: string; readonly hasData: boolean }[],
): string | undefined {
  if (items.length === 0) return undefined;
  let folder: string | undefined;
  let hasFolderEvidence = false;
  for (const item of items) {
    const slash = item.path.indexOf("/");
    const head = slash === -1 ? item.path : item.path.slice(0, slash);
    if (!head) return undefined;
    if (folder === undefined) folder = head;
    else if (folder !== head) return undefined;
    if (slash !== -1 || !item.hasData) hasFolderEvidence = true;
  }
  return hasFolderEvidence && folder ? normalizeWorkspaceName(folder) : undefined;
}

/** Safe `.zip` filename derived from a workspace display name. */
export function zipFilename(name: string): string {
  // Replacing control characters is intentional so downloaded filenames are safe across OSes.
  // oxlint-disable-next-line no-control-regex
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-").replace(/^[.\s-]+|[.\s-]+$/g, "");
  return `${cleaned || BLANK_DEFAULT_NAME}.zip`;
}

/**
 * Whether `meta.name` is a Sprockt-assigned placeholder that may be replaced by a real project name.
 * Legacy workspaces without `defaultName` are never treated as placeholders, so pre-existing
 * explicit renames (even to `"workspace"` or `"Shared workspace"`) are always preserved.
 */
export function isPlaceholderWorkspaceName(meta: WorkspaceMeta): boolean {
  return meta.defaultName === true;
}

export function createWorkspaceMeta(input: {
  readonly name: string;
  readonly template: string;
  readonly defaultName?: boolean;
  readonly now?: Date;
  readonly state?: WorkspaceState;
}): WorkspaceMeta {
  const timestamp = (input.now ?? new Date()).toISOString();
  const name = normalizeWorkspaceName(input.name) ?? BLANK_DEFAULT_NAME;
  return {
    name,
    template: input.template,
    created: timestamp,
    lastOpened: timestamp,
    ...(input.defaultName ? { defaultName: true } : {}),
    ...(input.state ? { state: input.state } : {}),
  };
}

function readStringField(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function readStateField(record: Readonly<Record<string, unknown>>): WorkspaceState | undefined {
  return record.state === INCOMPLETE ? INCOMPLETE : undefined;
}

function readWorkspaceSource(record: Readonly<Record<string, unknown>>): WorkspaceSource | undefined {
  const raw = record.source;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  if (source.kind === "share") {
    return { kind: "share", template: readStringField(source, "template") ?? "blank" };
  }
  if (source.kind !== "github") return undefined;
  const owner = readStringField(source, "owner");
  const repo = readStringField(source, "repo");
  if (!owner || !repo) return undefined;
  const ref = readStringField(source, "ref") ?? "";
  const subdir = readStringField(source, "subdir") ?? "";
  const commit = readStringField(source, "commit");
  return { kind: "github", owner, repo, ref, subdir, ...(commit ? { commit } : {}) };
}

export interface PartialWorkspaceMeta {
  readonly name?: string;
  readonly defaultName?: boolean;
  readonly template?: string;
  readonly created?: string;
  readonly lastOpened?: string;
  readonly state?: WorkspaceState;
  readonly source?: WorkspaceSource;
}

/**
 * Extracts every individually valid metadata field from raw `workspace.json`, even when other
 * fields (such as `created`) are missing. Used so partial recovery and renames never clobber
 * valid fields like `name`, `template`, `lastOpened`, `state`, or `source`.
 */
export function parsePartialWorkspaceMeta(raw: string | undefined): PartialWorkspaceMeta | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const source = readWorkspaceSource(record);
  const name = normalizeWorkspaceName(readStringField(record, "name") ?? "");
  const template = readStringField(record, "template") ?? (source?.kind === "github" ? "github" : undefined);
  const created = readStringField(record, "created") ?? readStringField(record, "createdAt");
  const lastOpened = readStringField(record, "lastOpened") ?? created;
  const state = readStateField(record);
  const defaultName = record.defaultName === true ? true : undefined;
  return {
    ...(name ? { name } : {}),
    ...(defaultName ? { defaultName } : {}),
    ...(template ? { template } : {}),
    ...(created ? { created } : {}),
    ...(lastOpened ? { lastOpened } : {}),
    ...(state ? { state } : {}),
    ...(source ? { source } : {}),
  };
}

export function parseWorkspaceMeta(raw: string): WorkspaceMeta | undefined {
  const partial = parsePartialWorkspaceMeta(raw);
  if (!partial) return undefined;
  const { source } = partial;
  const name =
    partial.name ??
    (source?.kind === "github" ? deriveGitHubWorkspaceName(source.repo, source.subdir) : undefined);
  const template = partial.template ?? "blank";
  const created = partial.created;
  const lastOpened = partial.lastOpened ?? created;
  if (!name || !created || !lastOpened) return undefined;
  return {
    name,
    template,
    created,
    lastOpened,
    ...(partial.defaultName ? { defaultName: true } : {}),
    ...(partial.state ? { state: partial.state } : {}),
    ...(source ? { source } : {}),
  };
}

function mergeMetaJson(raw: string | undefined, meta: WorkspaceMeta): string {
  if (!raw) return serializeWorkspaceMeta(meta);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const merged: Record<string, unknown> = {
        ...(parsed as Record<string, unknown>),
        name: meta.name,
        template: meta.template,
        created: meta.created,
        lastOpened: meta.lastOpened,
      };
      delete merged.defaultName;
      return `${JSON.stringify(merged, null, 2)}\n`;
    }
  } catch {
    // Fall through to clean serialized metadata.
  }
  return serializeWorkspaceMeta(meta);
}

function buildRecoveredMeta(
  raw: string | undefined,
  name: string,
  timestamp: string,
  preserveLastOpened: boolean,
): WorkspaceMeta {
  const partial = parsePartialWorkspaceMeta(raw);
  return {
    name,
    template: partial?.template ?? "blank",
    created: partial?.created ?? timestamp,
    lastOpened: preserveLastOpened ? (partial?.lastOpened ?? timestamp) : timestamp,
    ...(partial?.state ? { state: partial.state } : {}),
    ...(partial?.source ? { source: partial.source } : {}),
  };
}

/** Records an explicit user rename while preserving any valid fields (e.g. template, lastOpened, source, detected). */
export function updateWorkspaceMetaName(
  raw: string | undefined,
  nextName: string,
  now = new Date(),
): {
  readonly json: string;
  readonly meta: WorkspaceMeta;
} {
  const timestamp = now.toISOString();
  const fallback = buildRecoveredMeta(raw, nextName, timestamp, true);
  const json = mergeMetaJson(raw, fallback);
  return { json, meta: parseWorkspaceMeta(json) ?? fallback };
}

/** Updates an auto-derived workspace name while preserving valid fields and clearing any placeholder flag. */
export function mergeDerivedWorkspaceName(
  raw: string | undefined,
  derivedName: string,
  now = new Date(),
): {
  readonly json: string;
  readonly meta: WorkspaceMeta;
} {
  const timestamp = now.toISOString();
  const fallback = buildRecoveredMeta(raw, derivedName, timestamp, false);
  const json = mergeMetaJson(raw, fallback);
  return { json, meta: parseWorkspaceMeta(json) ?? fallback };
}

export function serializeWorkspaceMeta(meta: WorkspaceMeta): string {
  return `${JSON.stringify(meta, null, 2)}\n`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatRelativeTime(iso: string | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  const diffMs = Math.max(0, now.getTime() - time);
  const diffMinutes = Math.floor(diffMs / 60_000);
  if (diffMinutes < 1) return "Just now";
  if (diffMinutes < 60) return `${diffMinutes} m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays} d ago`;
  const date = new Date(time);
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}
