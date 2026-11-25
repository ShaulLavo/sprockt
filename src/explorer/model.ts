// The explorer's decisions as pure functions: which rows are visible, where the keys go, what a
// drop may do. No Solid and no DOM, so `bun test` covers them.
import { isSameOrInside, isInside, joinPath, parentOf } from "../files/paths";
import type { DirEntry } from "../files/tree";

/** Directory listings loaded so far, by directory path ("" is the project root). */
export type Listings = ReadonlyMap<string, readonly DirEntry[]>;

/** The one inline name box that can be open: a new entry, or a rename. */
export type Draft =
  | { readonly mode: "create"; readonly kind: "file" | "directory"; readonly parent: string }
  | { readonly mode: "rename"; readonly path: string };

export interface EntryRow {
  readonly type: "entry";
  /** Identifies the row across refreshes, so the view keeps its element (and its focus). */
  readonly key: string;
  readonly path: string;
  readonly name: string;
  readonly kind: "file" | "directory";
  readonly depth: number;
  readonly expanded: boolean;
  /** An expanded directory whose listing has not arrived yet. */
  readonly loading: boolean;
  /** Its name is being edited. */
  readonly editing: boolean;
}

/** The inline box for a new file or folder, shown at the top of its parent directory. */
export interface DraftRow {
  readonly type: "draft";
  readonly key: string;
  readonly parent: string;
  readonly kind: "file" | "directory";
  readonly depth: number;
}

export type Row = EntryRow | DraftRow;

export function visibleRows(listings: Listings, expanded: ReadonlySet<string>, draft?: Draft): Row[] {
  const rows: Row[] = [];
  const append = (directory: string, depth: number): void => {
    if (draft?.mode === "create" && draft.parent === directory) {
      rows.push({ type: "draft", key: "\0draft", parent: directory, kind: draft.kind, depth });
    }
    for (const entry of listings.get(directory) ?? []) {
      const path = joinPath(directory, entry.name);
      const isOpen = entry.kind === "directory" && expanded.has(path);
      rows.push({
        type: "entry",
        key: path,
        path,
        name: entry.name,
        kind: entry.kind,
        depth,
        expanded: isOpen,
        loading: isOpen && !listings.has(path),
        editing: draft?.mode === "rename" && draft.path === path,
      });
      if (isOpen) append(path, depth + 1);
    }
  };
  append("", 0);
  return rows;
}

export function entryRows(rows: readonly Row[]): EntryRow[] {
  return rows.filter((row) => row.type === "entry");
}

export type NavigationKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Home" | "End";

export interface Navigation {
  /** Move keyboard focus to this path. */
  readonly focus?: string;
  readonly expand?: string;
  readonly collapse?: string;
}

/** What an arrow key does from the `current` row, the way file trees everywhere behave. */
export function navigate(
  rows: readonly EntryRow[],
  current: string | undefined,
  key: NavigationKey,
): Navigation {
  if (rows.length === 0) return {};
  const index = rows.findIndex((row) => row.path === current);
  const row = rows[index];
  if (key === "Home") return { focus: rows[0]?.path };
  if (key === "End") return { focus: rows.at(-1)?.path };
  if (!row) return { focus: rows[0]?.path };
  if (key === "ArrowDown") return { focus: rows[Math.min(index + 1, rows.length - 1)]?.path };
  if (key === "ArrowUp") return { focus: rows[Math.max(index - 1, 0)]?.path };
  if (key === "ArrowRight") {
    if (row.kind !== "directory") return {};
    if (!row.expanded) return { expand: row.path };
    const next = rows[index + 1];
    return next && next.depth > row.depth ? { focus: next.path } : {};
  }
  if (row.kind === "directory" && row.expanded) return { collapse: row.path };
  const parent = parentOf(row.path);
  return parent === "" ? {} : { focus: parent };
}

/** The paths from `from` to `to` (inclusive) in visible order, for shift-click selection. */
export function rangeBetween(rows: readonly EntryRow[], from: string, to: string): string[] {
  const a = rows.findIndex((row) => row.path === from);
  const b = rows.findIndex((row) => row.path === to);
  if (a === -1 || b === -1) return [to];
  return rows.slice(Math.min(a, b), Math.max(a, b) + 1).map((row) => row.path);
}

/** Drops paths that sit inside another path of the set: moving a folder moves what is in it. */
export function topLevelPaths(paths: readonly string[]): string[] {
  return paths.filter((path) => !paths.some((other) => other !== path && isInside(path, other)));
}

/** Whether every one of `paths` can move into `directory`: not into itself, not where it already is. */
export function canMoveInto(paths: readonly string[], directory: string): boolean {
  return (
    paths.length > 0 &&
    paths.every((path) => !isSameOrInside(directory, path) && parentOf(path) !== directory)
  );
}

/** The directory a new file or upload goes into when `path` is selected: itself, or its parent. */
export function targetDirectory(path: string | undefined, kind: "file" | "directory" | undefined): string {
  if (path === undefined) return "";
  return kind === "directory" ? path : parentOf(path);
}

/** A rename's initial selection: the name without its last extension, like other editors. */
export function renameSelection(name: string): readonly [number, number] {
  const dot = name.lastIndexOf(".");
  return [0, dot > 0 ? dot : name.length];
}
