// Parses user input from the "open any GitHub repo" bar into a typed GitHub Route.
// Accepts owner/repo, owner/repo/tree/branch[/subdir], or any github.com URL.
import { parseRoute, routePath, type Route } from "../app/routes";

export type GithubRoute = Extract<Route, { kind: "github" }>;

const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

function stripGitSuffix(repo: string): string {
  return repo.endsWith(".git") && repo.length > 4 ? repo.slice(0, -4) : repo;
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
    return url.pathname.split("/").filter(Boolean);
  }

  if (trimmed.includes("://") || trimmed.includes(" ")) return undefined;
  const clean = trimmed.split(/[?#]/, 1)[0] ?? "";
  return clean
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean);
}

export function parseGithubInput(raw: string): GithubRoute | undefined {
  const segments = extractPathSegments(raw);
  if (!segments || segments.length < 2) return undefined;

  const [owner, rawRepo, marker, branch] = segments;
  if (!owner || !rawRepo) return undefined;
  const repo = stripGitSuffix(rawRepo);

  const candidate: GithubRoute =
    segments.length === 2
      ? { kind: "github", owner, repo }
      : marker === "tree" && branch
        ? buildTreeRoute(owner, repo, branch, segments.slice(4))
        : (undefined as never);

  if (!candidate) return undefined;
  const parsed = parseRoute(routePath(candidate));
  return parsed.kind === "github" ? parsed : undefined;
}

function buildTreeRoute(
  owner: string,
  repo: string,
  branch: string,
  subdirParts: readonly string[],
): GithubRoute {
  const subdir = subdirParts.join("/");
  return subdir ? { kind: "github", owner, repo, branch, subdir } : { kind: "github", owner, repo, branch };
}
