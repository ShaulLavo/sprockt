// When another tab takes a workspace over, this tab can no longer save. Its unsaved text goes
// to localStorage, keyed by workspace, and the tab that now owns the workspace shows it as an
// unsaved edit when the file is opened.
import type { Draft } from "./documents";

type TextStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const key = (workspace: string) => `sprockt:recovery:${workspace}`;

const isDraft = (value: unknown): value is Draft =>
  typeof value === "object" &&
  value !== null &&
  "text" in value &&
  typeof value.text === "string" &&
  (!("baseText" in value) || value.baseText === undefined || typeof value.baseText === "string");

function read(storage: TextStore, workspace: string): Record<string, Draft> {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(key(workspace)) ?? "{}");
    if (typeof parsed !== "object" || parsed === null) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, Draft] => isDraft(entry[1])),
    );
  } catch {
    return {};
  }
}

function write(storage: TextStore, workspace: string, drafts: Record<string, Draft>): void {
  if (Object.keys(drafts).length === 0) storage.removeItem(key(workspace));
  else storage.setItem(key(workspace), JSON.stringify(drafts));
}

/** Adds unsaved text to what is already waiting for this workspace. */
export function leaveForRecovery(storage: TextStore, workspace: string, drafts: Record<string, Draft>): void {
  if (Object.keys(drafts).length === 0) return;
  write(storage, workspace, { ...read(storage, workspace), ...drafts });
}

/** Takes the text waiting for one file, so it is recovered once. */
export function takeRecovered(storage: TextStore, workspace: string, path: string): Draft | undefined {
  const { [path]: draft, ...rest } = read(storage, workspace);
  if (draft) write(storage, workspace, rest);
  return draft;
}
