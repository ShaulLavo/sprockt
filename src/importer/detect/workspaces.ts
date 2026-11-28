// Monorepo workspace pattern parsing, Bun-compatible glob matching, and prefix-guided
// directory discovery for `package.json` `workspaces` and `pnpm-workspace.yaml`.
import { joinPath, normalizePath } from "../../lib/fs/path.ts";
import type { ProjectFs } from "../../lib/fs/types.ts";

const IGNORED_DIRS = new Set(["node_modules", ".git", ".sprockt", "dist", "build", ".next", ".nuxt"]);
const MAX_BRACE_EXPANSIONS = 256;

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

function splitInlineYamlList(content: string): string[] {
  const items: string[] = [];
  let quote: "'" | '"' | undefined;
  let start = 0;
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i];
    if (quote === '"' && ch === "\\") {
      i += 1;
      continue;
    }
    if (quote) {
      if (quote === "'" && ch === "'" && content[i + 1] === "'") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === ",") {
      items.push(content.slice(start, i));
      start = i + 1;
    }
  }
  items.push(content.slice(start));
  return items;
}

function parseInlineYamlList(inline: string): string[] {
  const patterns: string[] = [];
  for (const entry of splitInlineYamlList(inline.slice(1, -1))) {
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

/** Splits a top-level brace body (`a,b,{c,d}`) on unescaped commas outside nested braces/brackets. */
function splitBraceOptions(body: string): string[] {
  const options: string[] = [];
  let braceDepth = 0;
  let inClass = false;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "[" && !inClass) inClass = true;
    else if (ch === "]" && inClass) inClass = false;
    else if (!inClass && ch === "{") braceDepth += 1;
    else if (!inClass && ch === "}" && braceDepth > 0) braceDepth -= 1;
    else if (!inClass && braceDepth === 0 && ch === ",") {
      options.push(body.slice(start, i));
      start = i + 1;
    }
  }
  options.push(body.slice(start));
  return options;
}

/** Finds the first balanced `{...}` group containing at least one top-level comma. */
function findBraceGroup(pattern: string): { readonly open: number; readonly close: number } | undefined {
  let inClass = false;
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "[" && !inClass) {
      inClass = true;
      continue;
    }
    if (ch === "]" && inClass) {
      inClass = false;
      continue;
    }
    if (inClass || ch !== "{") continue;
    const close = findMatchingBrace(pattern, i);
    if (close !== undefined && splitBraceOptions(pattern.slice(i + 1, close)).length > 1) {
      return { open: i, close };
    }
  }
  return undefined;
}

function findMatchingBrace(pattern: string, openIndex: number): number | undefined {
  let depth = 0;
  let inClass = false;
  for (let i = openIndex; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "[" && !inClass) inClass = true;
    else if (ch === "]" && inClass) inClass = false;
    else if (!inClass && ch === "{") depth += 1;
    else if (!inClass && ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return undefined;
}

/** Expands Bun-style brace alternatives (`{apps,packages}/*`, nested braces) up to a safe cap. */
export function expandBraces(pattern: string): string[] {
  const queue = [pattern];
  const expanded: string[] = [];
  while (queue.length > 0 && expanded.length < MAX_BRACE_EXPANSIONS) {
    const current = queue.shift() ?? "";
    const group = findBraceGroup(current);
    if (!group) {
      expanded.push(current);
      continue;
    }
    const prefix = current.slice(0, group.open);
    const suffix = current.slice(group.close + 1);
    const options = splitBraceOptions(current.slice(group.open + 1, group.close));
    for (const option of options) {
      if (expanded.length + queue.length >= MAX_BRACE_EXPANSIONS) break;
      queue.push(`${prefix}${option}${suffix}`);
    }
  }
  return expanded;
}

function escapeRegexChar(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

/** Reads a glob character class `[abc]`, `[!a-z]`, or `[^a-z]` starting at `startIndex`. */
function readCharClass(
  segment: string,
  startIndex: number,
): { readonly regex: string; readonly end: number } {
  let index = startIndex + 1;
  let content = "";
  if (segment[index] === "!" || segment[index] === "^") {
    content += "^";
    index += 1;
  }
  if (segment[index] === "]") {
    content += "\\]";
    index += 1;
  }
  while (index < segment.length) {
    const ch = segment[index] ?? "";
    if (ch === "\\") {
      const next = segment[index + 1];
      if (next !== undefined) content += `\\${next}`;
      index += 2;
      continue;
    }
    if (ch === "]") return { regex: `[${content}]`, end: index };
    content += ch === "/" ? "" : escapeRegexChar(ch);
    index += 1;
  }
  return { regex: "\\[", end: startIndex };
}

/** Compiles one non-`**` glob path segment (supporting `*`, `?`, and `[...]` classes). */
function compileSegment(segment: string): RegExp | undefined {
  let source = "^";
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i] ?? "";
    if (ch === "\\") {
      const next = segment[i + 1];
      if (next !== undefined) source += escapeRegexChar(next);
      i += 1;
      continue;
    }
    if (ch === "*") source += "[^/]*";
    else if (ch === "?") source += "[^/]";
    else if (ch === "[") {
      const parsed = readCharClass(segment, i);
      source += parsed.regex;
      i = parsed.end;
    } else source += escapeRegexChar(ch);
  }
  try {
    return new RegExp(`${source}$`);
  } catch {
    return undefined;
  }
}

interface CompiledSegment {
  readonly globstar: boolean;
  readonly raw: string;
  readonly allowHidden: boolean;
  readonly regex: RegExp | undefined;
}

interface CompiledPattern {
  readonly segments: readonly CompiledSegment[];
  readonly hasGlobstar: boolean;
  readonly maxDepth: number;
}

function hasGlobSyntax(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "*" || ch === "?" || ch === "[" || ch === "{") return true;
  }
  return false;
}

function unescapeLiteralPath(pattern: string): string {
  return pattern.replace(/\\(.)/g, "$1");
}

function compilePattern(pattern: string): CompiledPattern | undefined {
  const parts = pattern.split("/").filter((part) => part !== "");
  const segments: CompiledSegment[] = [];
  for (const raw of parts) {
    const globstar = raw === "**";
    const regex = globstar ? undefined : compileSegment(raw);
    if (!globstar && !regex) return undefined;
    segments.push({
      globstar,
      raw,
      allowHidden: raw.startsWith(".") || raw.startsWith("\\."),
      regex,
    });
  }
  const hasGlobstar = segments.some((segment) => segment.globstar);
  const maxDepth = hasGlobstar ? Number.POSITIVE_INFINITY : segments.length;
  return { segments, hasGlobstar, maxDepth };
}

function matchesSegment(dirSegment: string, patSegment: CompiledSegment, matchHidden: boolean): boolean {
  if (!matchHidden && dirSegment.startsWith(".") && !patSegment.allowHidden) return false;
  return patSegment.regex?.test(dirSegment) ?? false;
}

function matchSegments(
  dirSegments: readonly string[],
  patternSegments: readonly CompiledSegment[],
  dirIndex: number,
  patIndex: number,
  matchHidden: boolean,
): boolean {
  if (patIndex === patternSegments.length) return dirIndex === dirSegments.length;
  const current = patternSegments[patIndex];
  if (!current) return false;
  if (current.globstar) {
    // `**` matches zero or more path segments (skipping hidden ones during positive discovery).
    if (matchSegments(dirSegments, patternSegments, dirIndex, patIndex + 1, matchHidden)) return true;
    const nextDir = dirSegments[dirIndex];
    if (nextDir !== undefined && (matchHidden || !nextDir.startsWith("."))) {
      return matchSegments(dirSegments, patternSegments, dirIndex + 1, patIndex, matchHidden);
    }
    return false;
  }
  if (dirIndex >= dirSegments.length) return false;
  const segment = dirSegments[dirIndex] ?? "";
  if (!matchesSegment(segment, current, matchHidden)) return false;
  return matchSegments(dirSegments, patternSegments, dirIndex + 1, patIndex + 1, matchHidden);
}

/** True when `prefixSegments` can match a strict ancestor of some path accepted by `pattern`. */
function canMatchDescendant(
  prefixSegments: readonly string[],
  patternSegments: readonly CompiledSegment[],
  dirIndex: number,
  patIndex: number,
): boolean {
  if (dirIndex === prefixSegments.length) {
    // We matched the entire prefix; a strict descendant is possible if any segment remains.
    return patIndex < patternSegments.length;
  }
  const current = patternSegments[patIndex];
  if (!current) return false;
  if (current.globstar) {
    if (canMatchDescendant(prefixSegments, patternSegments, dirIndex, patIndex + 1)) return true;
    const nextDir = prefixSegments[dirIndex];
    if (nextDir !== undefined && !nextDir.startsWith(".")) {
      return canMatchDescendant(prefixSegments, patternSegments, dirIndex + 1, patIndex);
    }
    return false;
  }
  const segment = prefixSegments[dirIndex] ?? "";
  if (!matchesSegment(segment, current, false)) return false;
  return canMatchDescendant(prefixSegments, patternSegments, dirIndex + 1, patIndex + 1);
}

interface CompiledWorkspacePatterns {
  readonly literals: ReadonlySet<string>;
  readonly positives: readonly CompiledPattern[];
  readonly negatives: readonly CompiledPattern[];
}

function addLiteralPattern(body: string, literals: Set<string>, positives: CompiledPattern[]): void {
  const normalized = normalizePattern(body);
  if (!normalized || normalized.startsWith("!")) return;
  const compiled = compilePattern(normalized);
  if (!compiled || compiled.segments.length === 0) return;
  literals.add(unescapeLiteralPath(normalized));
  positives.push(compiled);
}

function compileWorkspacePatterns(patterns: readonly string[]): CompiledWorkspacePatterns {
  const literals = new Set<string>();
  const positives: CompiledPattern[] = [];
  const negatives: CompiledPattern[] = [];
  for (const raw of patterns) {
    const negated = raw.startsWith("!");
    const body = negated ? raw.slice(1) : raw;
    if (!negated && !hasGlobSyntax(body)) {
      addLiteralPattern(body, literals, positives);
      continue;
    }
    for (const expanded of expandBraces(body)) {
      const normalized = normalizePattern(expanded);
      if (!normalized || normalized.startsWith("!")) continue;
      const compiled = compilePattern(normalized);
      if (!compiled || compiled.segments.length === 0) continue;
      if (negated) negatives.push(compiled);
      else positives.push(compiled);
    }
  }
  return { literals, positives, negatives };
}

function matchesPositivePattern(dirSegments: readonly string[], pattern: CompiledPattern): boolean {
  if (dirSegments.length > pattern.maxDepth) return false;
  return matchSegments(dirSegments, pattern.segments, 0, 0, false);
}

/** Matches a relative directory against workspace patterns, applying exclusions independently of order. */
export function matchesWorkspacePatterns(dir: string, patterns: readonly string[]): boolean {
  const compiled = compileWorkspacePatterns(patterns);
  return matchesCompiled(
    dir.split("/").filter((part) => part !== ""),
    compiled,
  );
}

function matchesCompiled(dirSegments: readonly string[], compiled: CompiledWorkspacePatterns): boolean {
  if (dirSegments.length === 0) return false;
  if (compiled.literals.has(dirSegments.join("/"))) return true;
  const included = compiled.positives.some((pattern) => matchesPositivePattern(dirSegments, pattern));
  if (!included) return false;
  const excluded = compiled.negatives.some((pattern) =>
    matchSegments(dirSegments, pattern.segments, 0, 0, true),
  );
  return !excluded;
}

function isIgnoredPath(dir: string): boolean {
  return dir.split("/").some((segment) => IGNORED_DIRS.has(segment));
}

/** Finds relative directories containing a `package.json` that match workspace patterns. */
export function matchWorkspaceDirs(paths: Iterable<string>, patterns: readonly string[]): string[] {
  if (patterns.length === 0) return [];
  const compiled = compileWorkspacePatterns(patterns);
  if (compiled.positives.length === 0) return [];
  const dirs = new Set<string>();
  for (const rawPath of paths) {
    const path = normalizePath(rawPath);
    if (!path || !path.endsWith("/package.json")) continue;
    const dir = path.slice(0, -"/package.json".length);
    if (!dir || isIgnoredPath(dir)) continue;
    if (matchesCompiled(dir.split("/"), compiled)) dirs.add(dir);
  }
  return Array.from(dirs).sort();
}

function maxTraversalDepth(compiled: CompiledWorkspacePatterns): number {
  let maxDepth = 0;
  for (const pattern of compiled.positives) {
    if (pattern.maxDepth > maxDepth) maxDepth = pattern.maxDepth;
  }
  return maxDepth;
}

/** Walks only directories reachable by positive workspace patterns (honoring explicit paths at any depth). */
export async function findWorkspaceDirsInFs(
  fs: ProjectFs,
  root: string,
  patterns: readonly string[],
): Promise<string[]> {
  if (patterns.length === 0) return [];
  const compiled = compileWorkspacePatterns(patterns);
  if (compiled.positives.length === 0) return [];
  const maxDepth = maxTraversalDepth(compiled);
  const found = new Set<string>();

  async function walk(segments: readonly string[]): Promise<void> {
    const relDir = segments.join("/");
    const entries = await fs.readdir(joinPath(root, relDir));
    const hasPkg = entries.some((entry) => entry.kind === "file" && entry.name === "package.json");
    if (segments.length > 0 && hasPkg && matchesCompiled(segments, compiled)) {
      found.add(relDir);
    }
    if (segments.length >= maxDepth) return;
    const nextDirs = entries
      .filter((entry) => entry.kind === "directory" && !IGNORED_DIRS.has(entry.name))
      .map((entry) => segments.concat(entry.name))
      .filter((child) =>
        compiled.positives.some(
          (pattern) =>
            matchesPositivePattern(child, pattern) ||
            (child.length < pattern.maxDepth && canMatchDescendant(child, pattern.segments, 0, 0)),
        ),
      );
    await Promise.all(nextDirs.map((child) => walk(child)));
  }

  await walk([]);
  return Array.from(found).sort();
}
