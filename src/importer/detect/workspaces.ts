// Monorepo workspace pattern parsing and directory matching for `package.json` `workspaces`
// and `pnpm-workspace.yaml`. Pure functions with no filesystem or UI dependencies.
import { joinPath, normalizePath } from "../../lib/fs/path.ts";
import type { ProjectFs } from "../../lib/fs/types.ts";

const IGNORED_DIRS = new Set(["node_modules", ".git", ".sprockt", "dist", "build", ".next", ".nuxt"]);
const MAX_WALK_DEPTH = 3;

function stripInlineComment(line: string): string {
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "#" && (index === 0 || /\s/.test(line[index - 1] ?? ""))) {
      return line.slice(0, index);
    }
  }
  return line;
}

function unquote(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function normalizePattern(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const negated = trimmed.startsWith("!");
  const body = (negated ? trimmed.slice(1) : trimmed).replace(/^\.\//, "").replace(/\/+$/, "");
  if (!body || body.includes("..")) return undefined;
  return negated ? `!${body}` : body;
}

function rawWorkspaceList(workspaces: unknown): readonly unknown[] {
  if (Array.isArray(workspaces)) return workspaces;
  if (typeof workspaces !== "object" || workspaces === null) return [];
  const packages = (workspaces as { readonly packages?: unknown }).packages;
  return Array.isArray(packages) ? packages : [];
}

/** Extracts workspace patterns from `package.json`'s `workspaces` field (array or `{ packages }`). */
export function parsePackageWorkspaces(workspaces: unknown): string[] {
  const patterns: string[] = [];
  for (const item of rawWorkspaceList(workspaces)) {
    if (typeof item !== "string") continue;
    const normalized = normalizePattern(item);
    if (normalized) patterns.push(normalized);
  }
  return patterns;
}

function parseInlineYamlList(inline: string): string[] {
  const patterns: string[] = [];
  for (const entry of inline.slice(1, -1).split(",")) {
    const normalized = normalizePattern(unquote(entry));
    if (normalized) patterns.push(normalized);
  }
  return patterns;
}

/** Extracts `packages:` glob patterns from a `pnpm-workspace.yaml` file. */
export function parsePnpmWorkspaceYaml(text: string | undefined): string[] {
  if (!text) return [];
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const patterns: string[] = [];
  let inPackages = false;
  let packagesIndent = -1;

  for (const rawLine of lines) {
    const cleaned = stripInlineComment(rawLine);
    const trimmed = cleaned.trim();
    if (!trimmed) continue;
    const indent = cleaned.length - cleaned.trimStart().length;

    if (!inPackages) {
      if (!/^packages\s*:/.test(trimmed)) continue;
      const inline = trimmed.slice(trimmed.indexOf(":") + 1).trim();
      if (inline.startsWith("[") && inline.endsWith("]")) {
        patterns.push(...parseInlineYamlList(inline));
        continue;
      }
      inPackages = true;
      packagesIndent = indent;
      continue;
    }

    if (indent <= packagesIndent && !trimmed.startsWith("-")) {
      inPackages = false;
      continue;
    }
    if (!trimmed.startsWith("-")) continue;
    const normalized = normalizePattern(unquote(trimmed.slice(1)));
    if (normalized) patterns.push(normalized);
  }
  return patterns;
}

function escapeRegex(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegExp(pattern: string): RegExp {
  const segments = pattern.split("/");
  const regexParts: string[] = [];
  for (const segment of segments) {
    if (segment === "**") {
      regexParts.push("(?:.+)?");
      continue;
    }
    const piece = segment.split("*").map(escapeRegex).join("[^/]*");
    regexParts.push(piece);
  }
  // Collapse `/**/` cleanly so `packages/**` matches both `packages/a` and `packages/a/b`.
  const source = regexParts
    .join("/")
    .replaceAll("/(?:.+)?/", "(?:/.*)?/")
    .replace(/\/\(\?:\.\+\)\?$/, "(?:/.*)?");
  return new RegExp(`^${source}$`);
}

function matchesWorkspacePatterns(dir: string, patterns: readonly string[]): boolean {
  let matched = false;
  for (const raw of patterns) {
    const negated = raw.startsWith("!");
    const pattern = negated ? raw.slice(1) : raw;
    if (!globToRegExp(pattern).test(dir)) continue;
    matched = !negated;
  }
  return matched;
}

function isIgnoredPath(dir: string): boolean {
  return dir.split("/").some((segment) => IGNORED_DIRS.has(segment));
}

/** Finds relative directories containing a `package.json` that match workspace patterns. */
export function matchWorkspaceDirs(paths: Iterable<string>, patterns: readonly string[]): string[] {
  if (patterns.length === 0) return [];
  const dirs = new Set<string>();
  for (const rawPath of paths) {
    const path = normalizePath(rawPath);
    if (!path || !path.endsWith("/package.json")) continue;
    const dir = path.slice(0, -"/package.json".length);
    if (!dir || isIgnoredPath(dir)) continue;
    if (matchesWorkspacePatterns(dir, patterns)) dirs.add(dir);
  }
  return Array.from(dirs).sort();
}

/** Walks up to `MAX_WALK_DEPTH` directories in `fs` to find workspace package directories. */
export async function findWorkspaceDirsInFs(
  fs: ProjectFs,
  root: string,
  patterns: readonly string[],
): Promise<string[]> {
  if (patterns.length === 0) return [];
  const found = new Set<string>();

  async function walk(relDir: string, depth: number): Promise<void> {
    if (depth > MAX_WALK_DEPTH) return;
    const entries = await fs.readdir(joinPath(root, relDir));
    const hasPkg = entries.some((entry) => entry.kind === "file" && entry.name === "package.json");
    if (relDir && hasPkg && matchesWorkspacePatterns(relDir, patterns)) {
      found.add(relDir);
    }
    if (depth === MAX_WALK_DEPTH) return;
    const subdirs = entries
      .filter((entry) => entry.kind === "directory" && !IGNORED_DIRS.has(entry.name))
      .map((entry) => (relDir ? `${relDir}/${entry.name}` : entry.name));
    await Promise.all(subdirs.map((sub) => walk(sub, depth + 1)));
  }

  await walk("", 0);
  return Array.from(found).sort();
}
