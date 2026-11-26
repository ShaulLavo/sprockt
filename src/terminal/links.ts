// Linear-time terminal file-path link parser and Ghostty LinkProvider. Turns compiler, Vite,
// TypeScript, and test stack-trace paths (`src/App.tsx:12:4`, `./index.ts(8,2)`) into clickable
// jump-to-line links in the editor.
import type { LinkLineSnapshot, LinkProvider, ProvidedLink } from "ghostty-webgpu";
import { PROJECT_ROOT, projectRelative } from "../workspace/paths";

export interface ParsedTerminalLink {
  /** UTF-16 inclusive start offset inside the line text. */
  readonly start: number;
  /** UTF-16 exclusive end offset inside the line text. */
  readonly end: number;
  /** Project-relative path (no leading slash or `./`). */
  readonly path: string;
  /** Optional 1-based line number. */
  readonly line?: number;
  /** Optional 1-based column number. */
  readonly column?: number;
}

const LEADING_TRIM = new Set(["(", "[", "{", "'", '"', "`", "<"]);
const TRAILING_TRIM = new Set([")", "]", "}", "'", '"', "`", ">", ",", ";", "."]);
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const VERSION_TOKEN_RE = /(?:^|\/)v?\d+\.\d+\.\d+(?:[-+][^\s]*)?$/i;
const FILE_EXT_RE = /\.[a-z0-9]{1,10}$/i;
const KNOWN_BARE_NAMES = new Set(["Makefile", "Dockerfile", "LICENSE", "README"]);

function normalizeCandidatePath(raw: string): string | undefined {
  let path = raw;
  if (path.startsWith(`${PROJECT_ROOT}/`)) {
    const rel = projectRelative(path);
    if (!rel) return undefined;
    path = rel;
  } else if (path.startsWith("/")) {
    return undefined;
  }
  while (path.startsWith("./")) path = path.slice(2);
  if (!path || path.startsWith("..") || path.includes("..")) return undefined;
  if (path.endsWith("/")) return undefined;
  if (VERSION_TOKEN_RE.test(path)) return undefined;
  const base = path.slice(path.lastIndexOf("/") + 1);
  const looksLikeFile = path.includes("/") || FILE_EXT_RE.test(base) || KNOWN_BARE_NAMES.has(base);
  if (!looksLikeFile) return undefined;
  return path;
}

function parseLocationSuffix(token: string): {
  readonly rawPath: string;
  readonly line?: number;
  readonly column?: number;
} {
  // TypeScript/MSBuild style: `src/App.tsx(12,4)` or `src/App.tsx(12)`
  const parens = /^(.*)\((\d+)(?:,(\d+))?\)$/.exec(token);
  if (parens?.[1] && parens[2]) {
    return {
      rawPath: parens[1],
      line: Number(parens[2]),
      column: parens[3] ? Number(parens[3]) : undefined,
    };
  }
  // Colon style: `src/App.tsx:12:4` or `src/App.tsx:12`
  const colons = /^(.*?):(\d+)(?::(\d+))?$/.exec(token);
  if (colons?.[1] && colons[2]) {
    return {
      rawPath: colons[1],
      line: Number(colons[2]),
      column: colons[3] ? Number(colons[3]) : undefined,
    };
  }
  return { rawPath: token };
}

/** Scans a terminal line in O(n) for plausible workspace file references with optional `:line:col`. */
export function parseTerminalFileLinks(text: string): ParsedTerminalLink[] {
  const results: ParsedTerminalLink[] = [];
  const length = text.length;
  let index = 0;

  while (index < length) {
    while (index < length && /\s/.test(text[index] ?? "")) index += 1;
    if (index >= length) break;
    const tokenStart = index;
    while (index < length && !/\s/.test(text[index] ?? "")) index += 1;
    const tokenEnd = index;

    let start = tokenStart;
    let end = tokenEnd;
    while (start < end && LEADING_TRIM.has(text[start] ?? "")) start += 1;
    // Strip common log prefixes like `ERROR:src/App.tsx:1`
    const slice = text.slice(start, end);
    const prefixMatch = /^(?:error|warn|warning|info|at):(?=\S)/i.exec(slice);
    if (prefixMatch) start += prefixMatch[0].length;

    while (end > start) {
      const ch = text[end - 1] ?? "";
      if (ch === ":" && !/:\d+$/.test(text.slice(start, end))) {
        end -= 1;
        continue;
      }
      if (!TRAILING_TRIM.has(ch)) break;
      // Keep closing `)` when it belongs to `file(line,col)`.
      if (ch === ")" && /\(\d+(?:,\d+)?\)$/.test(text.slice(start, end))) break;
      end -= 1;
    }
    if (end <= start) continue;

    const candidate = text.slice(start, end);
    if (URL_SCHEME_RE.test(candidate) || candidate.startsWith("mailto:") || candidate.startsWith("data:")) {
      continue;
    }
    const { rawPath, line, column } = parseLocationSuffix(candidate);
    const path = normalizeCandidatePath(rawPath);
    if (!path) continue;
    results.push({ start, end, path, line, column });
  }
  return results;
}

/** Parses a terminal-supplied URI (OSC 8 or detected URL) and allows only http: or https: URLs. */
export function safeExternalUrl(uri: string): string | undefined {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return parsed.href;
  } catch {
    return undefined;
  }
}

export interface WorkspaceLinkProviderOptions {
  exists(path: string): Promise<boolean>;
  openFile(path: string, location?: { readonly line?: number; readonly column?: number }): void;
}

/** Creates a Ghostty `LinkProvider` that verifies candidate paths exist in the workspace before linking. */
export function createWorkspaceLinkProvider(options: WorkspaceLinkProviderOptions): LinkProvider<Event> {
  return {
    async provideLinks(line: LinkLineSnapshot): Promise<readonly ProvidedLink<Event>[] | undefined> {
      const candidates = parseTerminalFileLinks(line.text);
      if (candidates.length === 0) return undefined;
      const checked = new Map<string, boolean>();
      const uniquePaths = Array.from(new Set(candidates.map((item) => item.path)));
      await Promise.all(
        uniquePaths.map(async (path) => {
          const present = await options.exists(path).catch(() => false);
          checked.set(path, present);
        }),
      );
      const links: ProvidedLink<Event>[] = [];
      for (const item of candidates) {
        if (!checked.get(item.path)) continue;
        const startCell = line.startCellByTextBoundary[item.start];
        const endCell = line.endCellByTextBoundary[item.end];
        if (startCell === undefined || endCell === undefined || endCell < startCell) continue;
        links.push({
          range: { start: startCell, end: endCell },
          text: line.text.slice(item.start, item.end),
          activate: () => {
            options.openFile(item.path, { line: item.line, column: item.column });
          },
        });
      }
      return links.length > 0 ? links : undefined;
    },
  };
}
