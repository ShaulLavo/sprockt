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

/** What a batch of watch events says about whether the project has a script file now. */
export interface ScriptCheck {
  /** A script file of the project's own was named. */
  readonly found: boolean;
  /**
   * Absolute paths to list: a rename names a moved or created directory only by itself, so a
   * script inside it shows up only when the directory is listed.
   */
  readonly recheck: readonly string[];
}

/** Events are `{ type, name }` with names relative to the filesystem root. */
export function checkForScripts(
  projectRoot: string,
  events: readonly { readonly type: "change" | "rename"; readonly name: string | null }[],
): ScriptCheck {
  const recheck = new Set<string>();
  for (const event of events) {
    const relative = event.name === null ? undefined : projectRelativeName(projectRoot, event.name);
    if (relative === undefined || isHeavyPath(relative)) continue;
    if (isScriptFile(relative)) return { found: true, recheck: [] };
    if (event.type === "rename") recheck.add(`${projectRoot}/${relative}`);
  }
  return { found: false, recheck: Array.from(recheck) };
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

function dependencyNames(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  return Object.keys(value);
}

/**
 * Direct npm packages declared in `package.json` (`dependencies` and `devDependencies`) that must
 * exist under `node_modules/<name>/package.json` before TypeScript checking starts.
 */
export function declaredPackages(packageJsonText: string | undefined): readonly string[] {
  if (!packageJsonText) return [];
  try {
    const parsed = JSON.parse(packageJsonText) as { dependencies?: unknown; devDependencies?: unknown };
    return Array.from(
      new Set(dependencyNames(parsed.dependencies).concat(dependencyNames(parsed.devDependencies))),
    );
  } catch {
    return [];
  }
}

/** Whether a batch of watch events changed `package.json` or anything under `node_modules`. */
export function touchesDependencyState(
  projectRoot: string,
  events: readonly { readonly name: string | null }[],
): boolean {
  for (const event of events) {
    if (event.name === null) continue;
    const relative = projectRelativeName(projectRoot, event.name);
    if (relative === "package.json" || relative === "node_modules" || relative?.startsWith("node_modules/")) {
      return true;
    }
  }
  return false;
}
