// Parses user input from the "open any GitHub repo" bar into a typed GitHub Route.
// Accepts owner/repo, owner/repo/tree/branch[/subdir], or any github.com URL.
import { parseRoute, routePath, type Route } from "../routing/routes";

export type GithubRoute = Extract<Route, { kind: "github" }>;

const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

function stripGitSuffix(repo: string): string {
  return repo.endsWith(".git") && repo.length > 4 ? repo.slice(0, -4) : repo;
}

function decodeSegment(raw: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  if (!decoded || decoded === "." || decoded === ".." || decoded.includes("\0")) return undefined;
  return decoded;
}

function decodeSegments(parts: readonly string[]): string[] | undefined {
  const decoded: string[] = [];
  for (const part of parts) {
    const value = decodeSegment(part);
    if (!value) return undefined;
    decoded.push(value);
  }
  return decoded;
}

function extractPathSegments(raw: string): string[] | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const hasScheme = /^https?:\/\//i.test(trimmed);
  const looksLikeGithubHost = /^(?:www\.)?github\.com(?:\/|$)/i.test(trimmed);
  if (hasScheme || looksLikeGithubHost) {
    let url: URL;
    try {
      url = new URL(hasScheme ? trimmed : `https://${trimmed}`);
    } catch {
      return undefined;
    }
    if (!GITHUB_HOSTS.has(url.hostname.toLowerCase())) return undefined;
    // Decode the raw path before URL dot-segment normalization collapses `/..` or `/%2e%2e`.
    const withoutAuthority = (hasScheme ? trimmed : `https://${trimmed}`).replace(/^https?:\/\/[^/?#]+/i, "");
    const rawPathname = withoutAuthority.split(/[?#]/, 1)[0] ?? "";
    return decodeSegments(rawPathname.split("/").filter(Boolean));
  }

  if (trimmed.includes("://") || trimmed.includes(" ")) return undefined;
  const clean = trimmed.split(/[?#]/, 1)[0] ?? "";
  return decodeSegments(
    clean
      .replace(/^\/+|\/+$/g, "")
      .split("/")
      .filter(Boolean),
  );
}

function buildTreeRoute(
  owner: string,
  repo: string,
  branch: string,
  subdirParts: readonly string[],
): GithubRoute | undefined {
  if (subdirParts.some((part) => part.includes("/"))) return undefined;
  const subdir = subdirParts.join("/");
  return subdir ? { kind: "github", owner, repo, branch, subdir } : { kind: "github", owner, repo, branch };
}

export function parseGithubInput(raw: string): GithubRoute | undefined {
  const segments = extractPathSegments(raw);
  if (!segments || segments.length < 2) return undefined;

  const [owner, rawRepo, marker, branch] = segments;
  if (!owner || !rawRepo) return undefined;
  const repo = stripGitSuffix(rawRepo);
  if (!repo || repo === "." || repo === "..") return undefined;

  let candidate: GithubRoute | undefined;
  if (segments.length === 2) candidate = { kind: "github", owner, repo };
  else if (marker === "tree" && branch) candidate = buildTreeRoute(owner, repo, branch, segments.slice(4));
  if (!candidate) return undefined;
  const parsed = parseRoute(routePath(candidate));
  return parsed.kind === "github" ? parsed : undefined;
}
