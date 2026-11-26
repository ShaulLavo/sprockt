// Turns the project detection of `importer/detect` into the one shell command that brings a
// project's dev server up, and gives that detection a read-only view of the workspace's files.
import type { FileService } from "../files/service";
import { detectProjectInFs, type ProjectDetection } from "../importer/detect/detect";
import type { FsDirent, ProjectFs } from "../lib/fs/types";

const readOnly = (): never => {
  throw new Error("Project detection only reads files");
};

/** The entries directly inside `directory` (`""` is the project root), from a file listing. */
export function entriesOf(files: readonly string[], directory: string): FsDirent[] {
  const prefix = directory ? `${directory}/` : "";
  const kinds = new Map<string, FsDirent["kind"]>();
  for (const file of files) {
    if (!file.startsWith(prefix)) continue;
    const [name, ...deeper] = file.slice(prefix.length).split("/");
    if (name) kinds.set(name, deeper.length > 0 ? "directory" : "file");
  }
  return Array.from(kinds, ([name, kind]) => ({ name, kind }));
}

/** What detection needs of a filesystem, answered by the workspace's file service. */
async function projectView(files: FileService): Promise<ProjectFs> {
  const listing = await files.list();
  return {
    readFile: (path) => files.readBytes(path),
    readdir: async (path) => entriesOf(listing, path),
    stat: readOnly,
    writeFile: readOnly,
    mkdir: readOnly,
  };
}

export async function detectWorkspace(files: FileService): Promise<ProjectDetection> {
  return detectProjectInFs(await projectView(files));
}

const shellWord = (word: string) =>
  /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;

/** How the dev-server task starts a project. */
export interface DevStart {
  /** The shell command for the first start, with the install in front when one is needed. */
  readonly script: string;
  /**
   * What to run again when a source file changes, for a command that does not pick edits up by
   * itself. Undefined when it does (a dev script: Vite, `bun --hot`, whatever the project chose).
   */
  readonly rerun: string | undefined;
}

/**
 * How to bring the dev server up, installing dependencies first when the project declares some
 * and has none installed. Undefined when nothing can be started.
 *
 * A project without a dev script is started from its entry file with plain `bun <file>`, which
 * serves what it loaded and never looks at the file again, so the task runs it again on a change.
 */
export function devStart(detection: ProjectDetection, hasNodeModules: boolean): DevStart | undefined {
  if (!detection.dev) return undefined;
  const start = [detection.dev.command].concat(detection.dev.args).map(shellWord).join(" ");
  const install = detection.install && !hasNodeModules;
  const bareEntry = detection.devScript === undefined && detection.dev.command === "bun";
  return { script: install ? `bun install && ${start}` : start, rerun: bareEntry ? start : undefined };
}
