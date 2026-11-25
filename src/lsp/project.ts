// What the TypeScript language server needs to know about the project, with no runtime in it:
// which files make a project worth a server, and how filesystem changes become the
// `workspace/didChangeWatchedFiles` events the server reads, since it cannot watch on its own.
import { isHeavyPath } from "../files/tree";

const SCRIPT_FILE = /\.(?:[cm]?[jt]sx?)$/;

/** A TypeScript or JavaScript source file, by name. */
export function isScriptFile(path: string): boolean {
  return SCRIPT_FILE.test(path);
}

/**
 * Whether the project has a source file of its own: dependencies and `.git` do not count, so an
 * installed package does not start a server for a project that has no script in it.
 */
export function hasOwnScriptFile(relativePaths: Iterable<string>): boolean {
  for (const path of relativePaths) if (isScriptFile(path) && !isHeavyPath(path)) return true;
  return false;
}

/** The project-relative path of a filesystem-root-relative watch name, or undefined outside it. */
export function projectRelativeName(projectRoot: string, name: string): string | undefined {
  const prefix = `${projectRoot.slice(1)}/`;
  return name.startsWith(prefix) && name.length > prefix.length ? name.slice(prefix.length) : undefined;
}

/** LSP `FileChangeType`. */
export const FileChange = { created: 1, changed: 2, deleted: 3 } as const;
export type FileChangeType = (typeof FileChange)[keyof typeof FileChange];

/**
 * How one watch event reads to the server. A rename is reported for both ends of a move, for a
 * new file and for a removed one, so whether the path exists now tells them apart.
 */
export function fileChangeType(event: "change" | "rename", exists: boolean): FileChangeType {
  if (!exists) return FileChange.deleted;
  return event === "rename" ? FileChange.created : FileChange.changed;
}

/** Version control churn says nothing about sources; everything else, dependencies too, does. */
export function isWatchedPath(relativePath: string): boolean {
  return !relativePath.split("/").includes(".git");
}
