// The explorer's decisions as pure functions: which rows are visible, compact single-child folder
// chains, inline filtering, sticky ancestors, extension-preserving name splitting, and drag rules.
// No React and no DOM, so `bun test` covers them directly.
import { ancestorsOf, baseName, isInside, isSameOrInside, joinPath, parentOf } from "../files/paths";
import type { DirEntry } from "../files/tree";

/** Directory listings loaded so far, by directory path ("" is the project root). */
export type Listings = ReadonlyMap<string, readonly DirEntry[]>;

/** The one inline name box that can be open: a new entry, or a rename. */
export type Draft =
  | { readonly mode: "create"; readonly kind: "file" | "directory"; readonly parent: string }
  | { readonly mode: "rename"; readonly path: string };

/** One directory segment inside a compacted single-child folder chain (`src / app / ui`). */
export interface FolderSegment {
  readonly name: string;
  readonly path: string;
}

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
  /** Ordered ancestor directory paths from outermost to immediate parent row. */
  readonly ancestorPaths: readonly string[];
  /** Present when consecutive single-child directories are compacted onto one row. */
  readonly segments?: readonly FolderSegment[];
  /** True for ancestor directories shown only for context in a filtered tree. */
  readonly contextOnly?: boolean;
}

/** The inline box for a new file or folder, shown at the top of its parent directory. */
export interface DraftRow {
  readonly type: "draft";
  readonly key: string;
  readonly parent: string;
  readonly kind: "file" | "directory";
  readonly depth: number;
  readonly ancestorPaths: readonly string[];
}

export type Row = EntryRow | DraftRow;

export interface VisibleRowOptions {
  /** Collapse consecutive single-child directories onto one row. Defaults to true. */
  readonly compactFolders?: boolean;
}

function blocksCompaction(path: string, draft: Draft | undefined): boolean {
  if (!draft) return false;
  if (draft.mode === "create") return draft.parent === path;
  return draft.path === path;
}

function compactDirectoryChain(
  listings: Listings,
  expanded: ReadonlySet<string>,
  startName: string,
  startPath: string,
  draft: Draft | undefined,
  compact: boolean,
): { readonly segments: FolderSegment[]; readonly path: string; readonly open: boolean } {
  const segments: FolderSegment[] = [{ name: startName, path: startPath }];
  let currentPath = startPath;
  let currentOpen = expanded.has(currentPath);
  if (!compact) return { segments, path: currentPath, open: currentOpen };
  while (currentOpen && !blocksCompaction(currentPath, draft)) {
    const children = listings.get(currentPath);
    const only = children?.length === 1 ? children[0] : undefined;
    if (!only || only.kind !== "directory") break;
    const nextPath = joinPath(currentPath, only.name);
    if (draft?.mode === "rename" && draft.path === nextPath) break;
    segments.push({ name: only.name, path: nextPath });
    currentPath = nextPath;
    currentOpen = expanded.has(currentPath);
  }
  return { segments, path: currentPath, open: currentOpen };
}

export function visibleRows(
  listings: Listings,
  expanded: ReadonlySet<string>,
  draft?: Draft,
  options?: VisibleRowOptions,
): Row[] {
  const compact = options?.compactFolders ?? true;
  const rows: Row[] = [];

  const append = (directory: string, depth: number, ancestors: readonly string[]): void => {
    if (draft?.mode === "create" && draft.parent === directory) {
      rows.push({
        type: "draft",
        key: "\0draft",
        parent: directory,
        kind: draft.kind,
        depth,
        ancestorPaths: ancestors,
      });
    }
    for (const entry of listings.get(directory) ?? []) {
      const startPath = joinPath(directory, entry.name);
      if (entry.kind !== "directory") {
        rows.push({
          type: "entry",
          key: startPath,
          path: startPath,
          name: entry.name,
          kind: "file",
          depth,
          expanded: false,
          loading: false,
          editing: draft?.mode === "rename" && draft.path === startPath,
          ancestorPaths: ancestors,
        });
        continue;
      }

      const chain = compactDirectoryChain(listings, expanded, entry.name, startPath, draft, compact);
      rows.push({
        type: "entry",
        key: chain.path,
        path: chain.path,
        name: chain.segments.at(-1)?.name ?? entry.name,
        kind: "directory",
        depth,
        expanded: chain.open,
        loading: chain.open && !listings.has(chain.path),
        editing: draft?.mode === "rename" && draft.path === chain.path,
        ancestorPaths: ancestors,
        segments: chain.segments.length > 1 ? chain.segments : undefined,
      });
      if (chain.open) append(chain.path, depth + 1, ancestors.concat([chain.path]));
    }
  };

  append("", 0, []);
  return rows;
}

function compareTreeNode(
  a: { readonly name: string; readonly kind: "file" | "directory" },
  b: { readonly name: string; readonly kind: "file" | "directory" },
): number {
  if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
}

function collectListingEntries(
  listings: Listings,
  needle: string,
): { readonly files: Set<string>; readonly matchingDirs: Set<string> } {
  const files = new Set<string>();
  const matchingDirs = new Set<string>();
  for (const [dir, entries] of listings) {
    for (const entry of entries) {
      const full = joinPath(dir, entry.name);
      if (entry.kind !== "directory") files.add(full);
      else if (full.toLowerCase().includes(needle)) matchingDirs.add(full);
    }
  }
  return { files, matchingDirs };
}

/**
 * Builds a filtered tree of entries whose path or filename contains `query` (case-insensitive),
 * keeping all matching ancestor folders expanded in sorted tree order.
 */
export function filterRows(allPaths: readonly string[], query: string, listings: Listings): EntryRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const { files: fileSet, matchingDirs } = collectListingEntries(listings, needle);
  for (const file of allPaths) fileSet.add(file);

  const includedFiles = new Set<string>();
  const includedDirs = new Set<string>();

  for (const file of fileSet) {
    if (!file.toLowerCase().includes(needle)) continue;
    includedFiles.add(file);
    for (const anc of ancestorsOf(file)) includedDirs.add(anc);
  }
  for (const dir of matchingDirs) {
    includedDirs.add(dir);
    for (const anc of ancestorsOf(dir)) includedDirs.add(anc);
  }

  const childrenByParent = new Map<string, { name: string; path: string; kind: "file" | "directory" }[]>();
  const addChild = (path: string, kind: "file" | "directory") => {
    const parent = parentOf(path);
    const list = childrenByParent.get(parent) ?? [];
    list.push({ name: baseName(path), path, kind });
    childrenByParent.set(parent, list);
  };
  for (const dir of includedDirs) addChild(dir, "directory");
  for (const file of includedFiles) addChild(file, "file");

  const rows: EntryRow[] = [];
  const walk = (directory: string, depth: number, ancestors: readonly string[]): void => {
    const children = (childrenByParent.get(directory) ?? []).toSorted(compareTreeNode);
    for (const child of children) {
      const isDir = child.kind === "directory";
      rows.push({
        type: "entry",
        key: child.path,
        path: child.path,
        name: child.name,
        kind: child.kind,
        depth,
        expanded: isDir,
        loading: false,
        editing: false,
        ancestorPaths: ancestors,
        contextOnly: isDir && !child.path.toLowerCase().includes(needle) ? true : undefined,
      });
      if (isDir) walk(child.path, depth + 1, ancestors.concat([child.path]));
    }
  };
  walk("", 0, []);
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
  const index = rows.findIndex(
    (row) => row.path === current || (row.segments?.some((segment) => segment.path === current) ?? false),
  );
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
  if (row.kind === "directory" && row.expanded) return { collapse: row.segments?.[0]?.path ?? row.path };
  const parent = row.ancestorPaths.at(-1) ?? parentOf(row.segments?.[0]?.path ?? row.path);
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

const COMPOUND_EXT_RE = /\.(?:test|spec|stories|config|module|d)\.[a-z0-9]+$/i;
const MAX_EXTENSION_LEN = 11;

/**
 * Splits a filename into a truncatable stem and a preserved extension (`.tsx`, `.test.ts`, `.d.ts`)
 * so narrow sidebars never clip away the file type.
 */
export function splitFilename(name: string): { readonly stem: string; readonly ext: string } {
  const compound = COMPOUND_EXT_RE.exec(name);
  if (compound && compound.index > 0 && compound[0].length <= MAX_EXTENSION_LEN + 2) {
    return { stem: name.slice(0, compound.index), ext: compound[0] };
  }
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { stem: name, ext: "" };
  const ext = name.slice(dot);
  if (ext.length > MAX_EXTENSION_LEN) return { stem: name, ext: "" };
  return { stem: name.slice(0, dot), ext };
}

/**
 * Returns the open ancestor directory rows (capped at `maxCount`) that have scrolled above
 * `firstVisibleIndex` so the tree can pin them cleanly as sticky headers.
 */
export function stickyAncestors(
  rows: readonly EntryRow[],
  firstVisibleIndex: number,
  maxCount = 3,
): EntryRow[] {
  if (firstVisibleIndex <= 0 || firstVisibleIndex >= rows.length) return [];
  const first = rows[firstVisibleIndex];
  if (!first || first.ancestorPaths.length === 0) return [];
  const byPath = new Map<string, EntryRow>();
  for (let index = 0; index < firstVisibleIndex; index += 1) {
    const candidate = rows[index];
    if (candidate && candidate.kind === "directory" && candidate.expanded) {
      byPath.set(candidate.path, candidate);
    }
  }
  const result: EntryRow[] = [];
  for (const anc of first.ancestorPaths) {
    const row = byPath.get(anc);
    if (row) result.push(row);
  }
  return result.slice(-maxCount);
}
