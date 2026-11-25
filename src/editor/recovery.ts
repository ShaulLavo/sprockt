// When another tab takes a workspace over, this tab can no longer save. The text storage does
// not hold yet goes to localStorage, and the tab that now owns the workspace shows it as an
// unsaved edit when the file is opened.
//
// Each file's text has its own key. Nothing reads a shared list, changes it and writes it back,
// so two tabs leaving or finishing text at the same moment cannot lose each other's entries.
// An entry stays until its text is safely in storage or the person discards it; opening the
// file does not remove it.

/** Unsaved text of one file. */
export interface Draft {
  readonly text: string;
  /** What the file held when this text was last in step with it; absent: it did not exist. */
  readonly baseText?: string | undefined;
}

type TextStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** `v1` is the format of the stored value. */
const key = (workspace: string, path: string) =>
  `sprockt:recovery:v1:${workspace}:${encodeURIComponent(path)}`;

const isDraft = (value: unknown): value is Draft =>
  typeof value === "object" &&
  value !== null &&
  "text" in value &&
  typeof value.text === "string" &&
  (!("baseText" in value) || value.baseText === undefined || typeof value.baseText === "string");

/** Leaves each text where the tab that owns the workspace next will find it. */
export function leaveForRecovery(
  storage: TextStore,
  workspace: string,
  drafts: ReadonlyMap<string, Draft>,
): void {
  for (const [path, draft] of drafts) storage.setItem(key(workspace, path), JSON.stringify(draft));
}

/** The text waiting for one file. It stays in place: see `discardRecovered`. */
export function recovered(storage: TextStore, workspace: string, path: string): Draft | undefined {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(key(workspace, path)) ?? "null");
    return isDraft(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Call once the file's text is safely in storage, or the person chose to drop it. */
export function discardRecovered(storage: TextStore, workspace: string, path: string): void {
  storage.removeItem(key(workspace, path));
}
