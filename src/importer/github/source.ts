import { isOwnerName, isRefComponent, isRefName, isRepoName } from "./names.ts";

/**
 * What to import from GitHub. `/tree/<ref>/<path>` URLs are ambiguous when the
 * branch name has slashes (`feature/x/src` could be branch `feature/x`, path
 * `src`), so the parser keeps the raw segments; `refCandidates` lists the
 * possible splits and `chooseSplit` resolves them against the real refs.
 */
export interface GitHubSource {
  readonly owner: string;
  readonly repo: string;
  /** Segments after `tree/`, `blob/` or `commit/`: a ref followed by a path. Empty means the default branch. */
  readonly refAndPath: readonly string[];
  /** `blob` URLs name a file: the importer takes the whole repository at that ref. */
  readonly target: "tree" | "blob";
}

export interface RefSplit {
  readonly ref: string;
  readonly subdir: string;
}

export type ParseResult =
  | { readonly ok: true; readonly source: GitHubSource }
  | { readonly ok: false; readonly error: string };

const HOSTS = new Set(["github.com", "www.github.com"]);

/**
 * Accepts the app's `/github/<owner>/<repo>[/tree/<ref>/<path>]` routes, pasted
 * `github.com` URLs (with or without scheme, `www.`, `.git`, trailing slash,
 * `blob/` file links, query or hash), `git@github.com:owner/repo.git`, and the
 * `owner/repo` shorthand.
 */
export function parseGitHubSource(input: string): ParseResult {
  const segments = sourceSegments(input.trim());
  if (!segments) return fail(input);
  const [owner = "", rawRepo = "", kind, ...rest] = segments;
  const repo = rawRepo.endsWith(".git") ? rawRepo.slice(0, -4) : rawRepo;
  if (!isOwnerName(owner)) return { ok: false, error: `"${owner}" is not a valid GitHub owner name` };
  if (!isRepoName(repo)) return { ok: false, error: `"${repo}" is not a valid GitHub repository name` };
  const refAndPath = kind === "tree" || kind === "blob" || kind === "commit" ? rest : [];
  if (refAndPath.length > 0 && !isRefComponent(refAndPath[0] ?? "")) {
    return { ok: false, error: `"${refAndPath[0]}" is not a valid branch, tag or commit` };
  }
  const target = kind === "blob" ? "blob" : "tree";
  return { ok: true, source: { owner, repo, refAndPath, target } };
}

function fail(input: string): ParseResult {
  return { ok: false, error: `"${input}" is not a GitHub repository URL` };
}

function sourceSegments(input: string): string[] | undefined {
  const ssh = /^git@github\.com:(.+)$/.exec(input);
  if (ssh) return splitPath(ssh[1] ?? "");
  if (input.startsWith("/github/")) return splitPath(input.slice("/github/".length));
  const withScheme = /^[a-z]+:\/\//i.test(input) ? input : `https://${input}`;
  const url = safeUrl(withScheme);
  if (url && HOSTS.has(url.hostname.toLowerCase())) return splitPath(url.pathname);
  // `owner/repo` shorthand: exactly two segments, no host-like first segment.
  const parts = splitPath(input);
  if (parts?.length === 2 && !(parts[0] ?? "").includes(".")) return parts;
  return undefined;
}

function safeUrl(text: string): URL | undefined {
  try {
    return new URL(text);
  } catch {
    return undefined;
  }
}

function splitPath(path: string): string[] | undefined {
  const clean = path.replace(/[?#].*$/, "");
  const segments = clean.split("/").filter((segment) => segment !== "");
  try {
    return segments.map((segment) => decodeURIComponent(segment));
  } catch {
    return undefined;
  }
}

/**
 * Every possible `{ref, subdir}` split of a source, shortest ref first. An
 * empty `ref` means "the default branch". The importer picks the longest split
 * whose ref really exists (see `chooseSplit`).
 */
export function refCandidates(source: GitHubSource): RefSplit[] {
  const segments = source.refAndPath;
  if (segments.length === 0) return [{ ref: "", subdir: "" }];
  return Array.from(segments, (_, index) => ({
    ref: segments.slice(0, index + 1).join("/"),
    subdir: source.target === "blob" ? "" : segments.slice(index + 1).join("/"),
  })).filter((split) => isRefName(split.ref));
}

/** The branches and tags whose names start with a source's first ref segment. */
export interface MatchingRefs {
  readonly branches: readonly string[];
  readonly tags: readonly string[];
}

/**
 * The split whose ref is the longest existing branch or tag; a branch wins
 * over a tag of the same name. `fetchRef` is the fully qualified ref
 * (`refs/heads/x`) so the archive cannot pick the other kind.
 */
export function chooseSplit(
  splits: readonly RefSplit[],
  refs: MatchingRefs,
): (RefSplit & { readonly fetchRef: string }) | undefined {
  const branches = new Set(refs.branches);
  const tags = new Set(refs.tags);
  for (const split of splits.toReversed()) {
    if (branches.has(split.ref)) return { ...split, fetchRef: `refs/heads/${split.ref}` };
    if (tags.has(split.ref)) return { ...split, fetchRef: `refs/tags/${split.ref}` };
  }
  return undefined;
}

/** The app route that imports (forks) a GitHub repository: `/github/owner/repo[/tree/ref/subdir]`. */
export function githubImportPath(owner: string, repo: string, ref = "", subdir = ""): string {
  const base = `/github/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  if (ref === "") return base;
  const tail = [ref, subdir]
    .filter((part) => part !== "")
    .flatMap((part) => part.split("/"))
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${base}/tree/${tail}`;
}
