// Metadata stored at /.sprockt/workspace.json inside each Waffle workspace.
// Pure parsing, validation, and formatting: no Solid, no DOM, no Waffle imports.

export const WORKSPACE_META_DIR = "/.sprockt";
export const WORKSPACE_META_PATH = "/.sprockt/workspace.json";

const MAX_NAME_LENGTH = 64;

export interface WorkspaceMeta {
  readonly name: string;
  readonly template: string;
  readonly created: string;
  readonly lastOpened: string;
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
}): WorkspaceMeta {
  const timestamp = (input.now ?? new Date()).toISOString();
  const name = normalizeWorkspaceName(input.name) ?? "workspace";
  return {
    name,
    template: input.template,
    created: timestamp,
    lastOpened: timestamp,
  };
}

function readStringField(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
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
  const template = readStringField(record, "template") ?? "blank";
  const created = readStringField(record, "created");
  const lastOpened = readStringField(record, "lastOpened") ?? created;
  if (!name || !created || !lastOpened) return undefined;
  return { name, template, created, lastOpened };
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
