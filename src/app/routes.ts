import { isWorkspaceId } from "../workspace/paths";

export type Route =
  | { readonly kind: "landing" }
  | { readonly kind: "workspace"; readonly id: string }
  | {
      readonly kind: "github";
      readonly owner: string;
      readonly repo: string;
      readonly branch?: string;
      readonly subdir?: string;
    }
  | { readonly kind: "not-found" };

const NOT_FOUND: Route = { kind: "not-found" };
const GITHUB_NAME = /^[A-Za-z0-9._-]+$/;

function githubRoute(parts: readonly string[]): Route {
  const [owner, repo, marker, branch] = parts;
  if (!owner || !repo || !GITHUB_NAME.test(owner) || !GITHUB_NAME.test(repo)) return NOT_FOUND;
  if (parts.length === 2) return { kind: "github", owner, repo };
  if (marker !== "tree" || !branch) return NOT_FOUND;
  const subdir = parts.slice(4).join("/");
  return subdir ? { kind: "github", owner, repo, branch, subdir } : { kind: "github", owner, repo, branch };
}

/** Maps a URL path to a page. Unknown paths are `not-found`, never a guess. */
export function parseRoute(pathname: string): Route {
  const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const [first, second] = parts;
  if (first === undefined) return { kind: "landing" };
  if (first === "github") return githubRoute(parts.slice(1));
  if (first !== "w" || parts.length !== 2 || !second || !isWorkspaceId(second)) return NOT_FOUND;
  return { kind: "workspace", id: second };
}

function githubPath(route: Extract<Route, { kind: "github" }>): string {
  const base = `/github/${route.owner}/${route.repo}`;
  if (!route.branch) return base;
  const tree = `${base}/tree/${encodeURIComponent(route.branch)}`;
  return route.subdir ? `${tree}/${route.subdir}` : tree;
}

export function routePath(route: Route): string {
  if (route.kind === "workspace") return `/w/${route.id}`;
  if (route.kind === "github") return githubPath(route);
  return "/";
}
