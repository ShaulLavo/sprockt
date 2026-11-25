import { PROJECT_ROOT } from "../workspace/paths";

export interface TreeNode {
  readonly name: string;
  /** Path relative to the project root, without a leading slash. */
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly children: TreeNode[];
}

/** Directories the explorer never expands into on its own: far too many entries to list. */
const HEAVY_DIRECTORIES = new Set(["node_modules", ".git"]);

export function isHeavyPath(path: string): boolean {
  return path.split("/").some((part) => HEAVY_DIRECTORIES.has(part));
}

const PROJECT_DIRECTORY = PROJECT_ROOT.slice(1);

/**
 * Whether a batch of changed paths (relative to the filesystem root) can change what the
 * explorer shows. A null name means "something changed, the watcher cannot say what".
 */
export function touchesProject(names: readonly (string | null)[]): boolean {
  return names.some((name) => {
    if (name === null) return true;
    const path = name.replace(/^\/+/, "");
    if (path === PROJECT_DIRECTORY) return true;
    return path.startsWith(`${PROJECT_DIRECTORY}/`) && !isHeavyPath(path.slice(PROJECT_DIRECTORY.length + 1));
  });
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
  return nodes.sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1,
  );
}

/** Builds the explorer tree from project-relative file paths: directories first, then by name. */
export function buildTree(files: readonly string[]): TreeNode[] {
  const roots: TreeNode[] = [];
  for (const file of files) insert(roots, file);
  return sortTree(roots);
}
