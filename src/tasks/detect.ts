// Turns the project detection of `importer/detect` into the one shell command that brings a
// project's dev server up, and gives that detection a read-only view of the workspace's files.
import type { FileService } from "../files/service";
import {
  detectProjectTargetsInFs,
  type ProjectDetection,
  type ProjectTargetsDetection,
  type WorkspaceTarget,
} from "../importer/detect/detect";
import type { FsDirent, ProjectFs } from "../lib/fs/types";

export type { WorkspaceTarget };

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

export async function detectWorkspaceTargets(files: FileService): Promise<ProjectTargetsDetection> {
  return detectProjectTargetsInFs(await projectView(files));
}

export async function detectWorkspace(files: FileService): Promise<ProjectDetection> {
  return (await detectWorkspaceTargets(files)).detection;
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

function startCommandText(command: ProjectDetection["dev"]): string | undefined {
  if (!command) return undefined;
  // Run workspace-subdir commands inside a subshell so an interactive dev terminal stays at `/workspace`.
  if (
    command.command === "bun" &&
    command.args.length === 4 &&
    command.args[0] === "run" &&
    command.args[1] === "--cwd"
  ) {
    const dir = command.args[2];
    const script = command.args[3];
    if (dir && script) return `(cd ${shellWord(dir)} && bun run ${shellWord(script)})`;
  }
  return [command.command].concat(command.args).map(shellWord).join(" ");
}

/**
 * How to bring the dev server up, installing dependencies first when the project declares some
 * and has none installed. Undefined when nothing can be started.
 *
 * A project without a dev script is started from its entry file with plain `bun <file>`, which
 * serves what it loaded and never looks at the file again, so the task runs it again on a change.
 */
export function devStart(detection: ProjectDetection, hasNodeModules: boolean): DevStart | undefined {
  const start = startCommandText(detection.dev);
  if (!start || !detection.dev) return undefined;
  const install = detection.install && !hasNodeModules;
  const bareEntry = detection.devScript === undefined && detection.dev.command === "bun";
  return { script: install ? `bun install && ${start}` : start, rerun: bareEntry ? start : undefined };
}

/** How to start one chosen monorepo/workspace target (or script). */
export function devStartForTarget(
  detection: ProjectDetection,
  target: WorkspaceTarget,
  hasNodeModules: boolean,
): DevStart {
  const start = target.dir
    ? `(cd ${shellWord(target.dir)} && bun run ${shellWord(target.script)})`
    : `bun run ${shellWord(target.script)}`;
  const install = detection.install && !hasNodeModules;
  return { script: install ? `bun install && ${start}` : start, rerun: undefined };
}
