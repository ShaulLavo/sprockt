import { PROJECT_ROOT } from "../workspace/paths";

export interface TreeNode {
  readonly name: string;
  /** Path relative to the project root, without a leading slash. */
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly children: TreeNode[];
}

/** One entry of a directory listing. */
export interface DirEntry {
  readonly name: string;
  readonly kind: "file" | "directory";
}

/** Directories the explorer never expands into on its own: far too many entries to list. */
const HEAVY_DIRECTORIES = new Set(["node_modules", ".git"]);

export function isHeavyName(name: string): boolean {
  return HEAVY_DIRECTORIES.has(name);
}

export function isHeavyPath(path: string): boolean {
  return path.split("/").some(isHeavyName);
}

const PROJECT_DIRECTORY = PROJECT_ROOT.slice(1);

/**
 * The project-relative path ("" for the project directory itself) a watcher event name (relative
 * to the filesystem root) points at, or undefined when the event cannot change what the project
 * shows: it is outside the project, or inside `node_modules` or `.git`.
 * The heavy directory itself still counts, because its parent's listing gains or loses it.
 */
export function toProjectPath(name: string): string | undefined {
  const path = name.replace(/^\/+/, "");
  if (path === PROJECT_DIRECTORY) return "";
  if (!path.startsWith(`${PROJECT_DIRECTORY}/`)) return undefined;
  const relative = path.slice(PROJECT_DIRECTORY.length + 1);
  const parts = relative.split("/");
  if (parts.slice(0, -1).some(isHeavyName)) return undefined;
  return relative;
}

/**
 * Whether a batch of changed paths (relative to the filesystem root) can change what the
 * explorer shows. A null name means "something changed, the watcher cannot say what".
 */
export function touchesProject(names: readonly (string | null)[]): boolean {
  return names.some((name) => name === null || toProjectPath(name) !== undefined);
}

/** Folders first, then by name, the way the explorer lists a directory. */
export function compareEntries(a: DirEntry, b: DirEntry): number {
  if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
  return (
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) ||
    (a.name < b.name ? -1 : 1)
  );
}

export function sortEntries(entries: readonly DirEntry[]): DirEntry[] {
  return entries.toSorted(compareEntries);
}

function childNamed(siblings: TreeNode[], name: string, path: string, kind: TreeNode["kind"]): TreeNode {
  const existing = siblings.find((node) => node.name === name);
  if (existing) return existing;
  const created: TreeNode = { name, path, kind, children: [] };
  siblings.push(created);
  return created;
}

function insert(roots: TreeNode[], file: string): void {
  const parts = file.split("/");
  let siblings = roots;
  for (const [index, name] of parts.entries()) {
    const kind = index === parts.length - 1 ? "file" : "directory";
    siblings = childNamed(siblings, name, parts.slice(0, index + 1).join("/"), kind).children;
  }
}

function sortTree(nodes: TreeNode[]): TreeNode[] {
  for (const node of nodes) sortTree(node.children);
  return nodes.sort(compareEntries);
}

/** Builds a tree from project-relative file paths: directories first, then by name. */
export function buildTree(files: readonly string[]): TreeNode[] {
  const roots: TreeNode[] = [];
  for (const file of files) insert(roots, file);
  return sortTree(roots);
}
