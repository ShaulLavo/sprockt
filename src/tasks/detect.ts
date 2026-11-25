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

/**
 * The shell command that brings the dev server up, installing dependencies first when the
 * project declares some and has none installed. Undefined when nothing can be started.
 */
export function devCommand(detection: ProjectDetection, hasNodeModules: boolean): string | undefined {
  if (!detection.dev) return undefined;
  const start = [detection.dev.command].concat(detection.dev.args).map(shellWord).join(" ");
  const install = detection.install && !hasNodeModules;
  return install ? `bun install && ${start}` : start;
}
