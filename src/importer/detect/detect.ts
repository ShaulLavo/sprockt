import { joinPath, normalizePath } from "../../lib/fs/path.ts";
import type { ProjectFs } from "../../lib/fs/types.ts";
import { decodeUtf8 } from "../../lib/bytes.ts";

export type PackageManager = "bun" | "npm" | "pnpm" | "yarn";

export type FrameworkId =
  | "next"
  | "nuxt"
  | "astro"
  | "sveltekit"
  | "react-router"
  | "remix"
  | "vite"
  | "hono"
  | "bun-serve";

export interface Command {
  readonly command: string;
  readonly args: readonly string[];
}

export interface ProjectDetection {
  /** `true` when the root has a `package.json`. */
  readonly hasPackageJson: boolean;
  /** The package manager the lockfile belongs to, `undefined` without a lockfile. */
  readonly packageManager: PackageManager | undefined;
  readonly lockfile: string | undefined;
  readonly framework: FrameworkId | undefined;
  /** Always `bun install` when there is a `package.json`: Sprockt runs Bun, which reads the other lockfiles. */
  readonly install: Command | undefined;
  /** The `package.json` script used, when one was. */
  readonly devScript: string | undefined;
  readonly dev: Command | undefined;
  /** The port the dev server is expected to listen on, when it can be known. */
  readonly port: number | undefined;
}

/** Root-level project files, as a workspace snapshot or a filesystem read provides them. */
export interface ProjectFiles {
  /** Paths relative to the project root. Only top-level names and a few entry files matter. */
  readonly paths: Iterable<string>;
  /** UTF-8 text of a file, `undefined` when missing or not text. */
  read(path: string): string | undefined;
}

const LOCKFILES: readonly (readonly [string, PackageManager])[] = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

const DEV_SCRIPTS = ["dev", "start", "serve"] as const;

/** Dependency that identifies each framework, most specific first (Remix and SvelteKit also depend on Vite). */
const FRAMEWORK_DEPS: readonly (readonly [string, FrameworkId])[] = [
  ["next", "next"],
  ["nuxt", "nuxt"],
  ["astro", "astro"],
  ["@sveltejs/kit", "sveltekit"],
  ["@react-router/dev", "react-router"],
  ["@remix-run/dev", "remix"],
  ["vite", "vite"],
  ["hono", "hono"],
];

/** CLI names at the start of a dev script, for projects whose framework is only visible there. */
const FRAMEWORK_BINS: Readonly<Record<string, FrameworkId>> = {
  next: "next",
  nuxt: "nuxt",
  nuxi: "nuxt",
  astro: "astro",
  "react-router": "react-router",
  remix: "remix",
  vite: "vite",
};

const DEFAULT_PORTS: Readonly<Record<FrameworkId, number>> = {
  next: 3000,
  nuxt: 3000,
  astro: 4321,
  sveltekit: 5173,
  "react-router": 5173,
  remix: 5173,
  vite: 5173,
  hono: 3000,
  "bun-serve": 3000,
};

/** How to start each framework's dev server when `package.json` has no dev script. */
const DEFAULT_DEV: Readonly<Record<Exclude<FrameworkId, "hono" | "bun-serve">, readonly string[]>> = {
  next: ["next", "dev"],
  nuxt: ["nuxi", "dev"],
  astro: ["astro", "dev"],
  sveltekit: ["vite", "dev"],
  "react-router": ["react-router", "dev"],
  remix: ["remix", "vite:dev"],
  vite: ["vite"],
};

const VITE_CONFIGS = ["vite.config.ts", "vite.config.js", "vite.config.mts", "vite.config.mjs"];
const SERVER_ENTRIES = [
  "index.ts",
  "server.ts",
  "src/index.ts",
  "src/server.ts",
  "index.js",
  "server.js",
  "src/index.js",
  "src/server.js",
  "index.tsx",
  "src/index.tsx",
];

interface PackageJson {
  readonly scripts?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly module?: string;
  readonly main?: string;
}

export function detectProject(files: ProjectFiles): ProjectDetection {
  const paths = new Set(files.paths);
  const pkgText = paths.has("package.json") ? files.read("package.json") : undefined;
  const pkg = parsePackageJson(pkgText);
  const lock = LOCKFILES.find(([name]) => paths.has(name));
  const devScript = DEV_SCRIPTS.find((name) => typeof pkg?.scripts?.[name] === "string");
  const scriptText = devScript ? (pkg?.scripts?.[devScript] ?? "") : "";
  const declared = frameworkFromDeps(pkg) ?? frameworkFromScript(scriptText);
  // Hono apps often `export default app`, which no pattern recognizes, so any entry file will do.
  const entry = serverEntry(paths, files, pkg) ?? (declared === "hono" ? firstEntry(paths, pkg) : undefined);
  const framework = declared ?? (entry ? "bun-serve" : undefined);
  return {
    hasPackageJson: pkgText !== undefined,
    packageManager: lock?.[1],
    lockfile: lock?.[0],
    framework,
    install: pkgText === undefined ? undefined : { command: "bun", args: ["install"] },
    devScript,
    dev: devCommand(devScript, framework, entry),
    port: detectPort(scriptText, framework, files, entry),
  };
}

/** Reads only the files detection needs from `fs`, rooted at `root`. */
export async function detectProjectInFs(fs: ProjectFs, root = ""): Promise<ProjectDetection> {
  const top = await fs.readdir(root);
  const srcDir = top.find((entry) => entry.name === "src" && entry.kind === "directory");
  const nested = srcDir ? await fs.readdir(joinPath(root, "src")) : [];
  const paths = top.map((entry) => entry.name).concat(nested.map((entry) => `src/${entry.name}`));
  const wanted = new Set(["package.json"].concat(VITE_CONFIGS, SERVER_ENTRIES));
  const texts = await readTexts(
    fs,
    root,
    paths.filter((candidate) => wanted.has(candidate)),
  );
  // An entry named by `module` or `main` may live anywhere in the tree.
  const declared = entryCandidates(parsePackageJson(texts.get("package.json"))).filter(
    (path) => !wanted.has(path),
  );
  const declaredTexts = await readTexts(fs, root, declared);
  for (const [path, text] of declaredTexts) texts.set(path, text);
  return detectProject({
    paths: paths.concat(Array.from(declaredTexts.keys())),
    read: (path) => texts.get(path),
  });
}

/** The UTF-8 text of each existing file in `paths`, read in parallel. */
async function readTexts(
  fs: ProjectFs,
  root: string,
  paths: readonly string[],
): Promise<Map<string, string>> {
  const texts = await Promise.all(
    paths.map(async (path) => {
      const bytes = await fs.readFile(joinPath(root, path));
      return [path, bytes ? decodeUtf8(bytes) : undefined] as const;
    }),
  );
  return new Map(texts.filter((entry): entry is readonly [string, string] => entry[1] !== undefined));
}

function parsePackageJson(text: string | undefined): PackageJson | undefined {
  if (text === undefined) return undefined;
  try {
    // Editors on Windows sometimes save package.json with a BOM; npm and Bun accept it.
    const value: unknown = JSON.parse(text.replace(/^﻿/, ""));
    return typeof value === "object" && value !== null ? (value as PackageJson) : undefined;
  } catch {
    return undefined;
  }
}

function frameworkFromDeps(pkg: PackageJson | undefined): FrameworkId | undefined {
  if (!pkg) return undefined;
  const deps = { ...pkg.devDependencies, ...pkg.dependencies };
  return FRAMEWORK_DEPS.find(([name]) => name in deps)?.[1];
}

function frameworkFromScript(script: string): FrameworkId | undefined {
  const bin = scriptWords(script).find((word) => word in FRAMEWORK_BINS);
  return bin === undefined ? undefined : FRAMEWORK_BINS[bin];
}

/** Words of a script, skipping env assignments and runners such as `bunx` or `npx`. */
function scriptWords(script: string): string[] {
  return script
    .split(/\s+/)
    .filter(
      (word) => word !== "" && !word.includes("=") && !["bunx", "npx", "pnpx", "bun", "x"].includes(word),
    );
}

/** The first server entry file that calls `Bun.serve` or exports a fetch handler. */
function serverEntry(
  paths: ReadonlySet<string>,
  files: ProjectFiles,
  pkg: PackageJson | undefined,
): string | undefined {
  return entryCandidates(pkg).find((path) => paths.has(path) && looksLikeServer(files.read(path)));
}

function firstEntry(paths: ReadonlySet<string>, pkg: PackageJson | undefined): string | undefined {
  return entryCandidates(pkg).find((path) => paths.has(path));
}

/** `module` and `main` from `package.json`, then the usual entry file names. */
function entryCandidates(pkg: PackageJson | undefined): string[] {
  const declared = [pkg?.module, pkg?.main].filter((path): path is string => typeof path === "string");
  // normalizePath drops `./` and refuses paths that leave the project.
  const normalized = declared
    .map((path) => normalizePath(path))
    .filter((path): path is string => Boolean(path));
  return normalized.concat(SERVER_ENTRIES);
}

function looksLikeServer(text: string | undefined): boolean {
  if (text === undefined) return false;
  return /\bBun\.serve\s*\(/.test(text) || /export\s+default\s*\{[^}]*\bfetch\b/.test(text);
}

function devCommand(
  devScript: string | undefined,
  framework: FrameworkId | undefined,
  entry: string | undefined,
): Command | undefined {
  if (devScript) return { command: "bun", args: ["run", devScript] };
  // A bare entry file is run as it is. `bun --hot` in bun-wasm refuses a file without an import
  // or export and a server with routes or WebSocket handlers, and there is no `--watch`; the
  // dev-server task restarts the file itself when the source changes (tasks/restarting.ts).
  if (entry) return { command: "bun", args: [entry] };
  if (!framework || framework === "hono" || framework === "bun-serve") return undefined;
  return { command: "bunx", args: DEFAULT_DEV[framework] };
}

function detectPort(
  script: string,
  framework: FrameworkId | undefined,
  files: ProjectFiles,
  entry: string | undefined,
): number | undefined {
  const fromScript = /(?:--port[=\s]+|(?:^|\s)-p\s+)(\d{2,5})\b/.exec(script)?.[1];
  if (fromScript) return validPort(fromScript);
  const configured = configuredPort(framework, files, entry);
  if (configured !== undefined) return configured;
  return framework ? DEFAULT_PORTS[framework] : undefined;
}

/** A `port: N` in the Vite config (for Vite-based frameworks) or in the `Bun.serve` entry. */
function configuredPort(
  framework: FrameworkId | undefined,
  files: ProjectFiles,
  entry: string | undefined,
): number | undefined {
  const viteBased =
    framework === "vite" ||
    framework === "sveltekit" ||
    framework === "react-router" ||
    framework === "remix";
  const sources = viteBased ? VITE_CONFIGS : entry ? [entry] : [];
  for (const path of sources) {
    const text = files.read(path) ?? "";
    // In a Vite config only `server.port` counts; `preview.port` and `server.hmr.port` are other servers.
    const scope = viteBased ? topLevelOf(objectBody(text, /\bserver\s*:\s*\{/)) : text;
    const match = /\bport\s*:\s*(\d{2,5})\b/.exec(scope);
    if (match?.[1]) return validPort(match[1]);
  }
  return undefined;
}

/** The text inside the braces of the first object literal that `opener` (ending in `{`) introduces. */
function objectBody(text: string, opener: RegExp): string {
  const match = opener.exec(text);
  if (!match) return "";
  const start = match.index + match[0].length;
  let depth = 1;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    depth += char === "{" ? 1 : char === "}" ? -1 : 0;
    if (depth === 0) return text.slice(start, index);
  }
  return text.slice(start);
}

/** Drops nested `{...}` groups, leaving only an object body's own properties. */
function topLevelOf(body: string): string {
  let previous = "";
  let current = body;
  while (current !== previous) {
    previous = current;
    current = current.replace(/\{[^{}]*\}/g, "");
  }
  return current;
}

function validPort(text: string): number | undefined {
  const port = Number(text);
  return port > 0 && port < 65536 ? port : undefined;
}
