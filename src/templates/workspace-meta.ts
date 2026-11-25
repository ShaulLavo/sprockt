// Metadata stored at /.sprockt/workspace.json inside each Waffle workspace.
// Pure parsing, validation, and formatting: no Solid, no DOM, no Waffle imports.
import {
  INCOMPLETE,
  WORKSPACE_META_DIR,
  WORKSPACE_META_PATH,
  type WorkspaceMeta as ImporterWorkspaceMeta,
  type WorkspaceSource,
} from "../importer/metadata";

export { INCOMPLETE, WORKSPACE_META_DIR, WORKSPACE_META_PATH };

const MAX_NAME_LENGTH = 64;

export type WorkspaceState = typeof INCOMPLETE;

export interface WorkspaceMeta extends ImporterWorkspaceMeta {
  readonly template: string;
  readonly lastOpened: string;
  readonly source?: WorkspaceSource;
}

export function normalizeWorkspaceName(raw: string): string | undefined {
  const collapsed = raw.trim().replace(/\s+/g, " ");
  if (!collapsed) return undefined;
  return collapsed.slice(0, MAX_NAME_LENGTH);
}

export function createWorkspaceMeta(input: {
  readonly name: string;
  readonly template: string;
  readonly now?: Date;
  readonly state?: WorkspaceState;
}): WorkspaceMeta {
  const timestamp = (input.now ?? new Date()).toISOString();
  const name = normalizeWorkspaceName(input.name) ?? "workspace";
  return input.state
    ? { name, template: input.template, created: timestamp, lastOpened: timestamp, state: input.state }
    : { name, template: input.template, created: timestamp, lastOpened: timestamp };
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

export function parseWorkspaceMeta(raw: string): WorkspaceMeta | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const name = normalizeWorkspaceName(readStringField(record, "name") ?? "");
  const source = readWorkspaceSource(record);
  const template = readStringField(record, "template") ?? (source?.kind === "github" ? "github" : "blank");
  const created = readStringField(record, "created") ?? readStringField(record, "createdAt");
  const lastOpened = readStringField(record, "lastOpened") ?? created;
  if (!name || !created || !lastOpened) return undefined;
  const state = readStateField(record);
  return {
    name,
    template,
    created,
    lastOpened,
    ...(state ? { state } : {}),
    ...(source ? { source } : {}),
  };
}

/** Updates only the workspace name while preserving any extra fields (e.g. importer source/detected). */
export function updateWorkspaceMetaName(
  raw: string | undefined,
  nextName: string,
  now = new Date(),
): {
  readonly json: string;
  readonly meta: WorkspaceMeta;
} {
  const existing = raw ? parseWorkspaceMeta(raw) : undefined;
  const timestamp = now.toISOString();
  const meta: WorkspaceMeta = existing
    ? { ...existing, name: nextName }
    : { name: nextName, template: "blank", created: timestamp, lastOpened: timestamp };

  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const merged = { ...(parsed as Record<string, unknown>), name: nextName };
        return { json: `${JSON.stringify(merged, null, 2)}\n`, meta };
      }
    } catch {
      // Fall through to clean serialized metadata.
    }
  }
  return { json: serializeWorkspaceMeta(meta), meta };
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
