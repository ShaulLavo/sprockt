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

/** The decoded path segments, or undefined when the percent-encoding is malformed (`/%`). */
function segments(pathname: string): string[] | undefined {
  try {
    return pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return undefined;
  }
}

/**
 * Maps a URL path to a page. Unknown and malformed paths are `not-found`, never a guess.
 *
 * In our own links a branch is one segment, with its slashes encoded (`feature%2Fx`). A URL
 * copied from GitHub has them unencoded (`/tree/feature/x/src`), and nothing in the URL says
 * where the branch ends. It parses as branch `feature`, subdir `x/src`; the importer resolves
 * `branch/subdir` against the repository's refs, longest match first, before it reads the rest
 * as a subdirectory.
 */
export function parseRoute(pathname: string): Route {
  const parts = segments(pathname);
  if (!parts) return NOT_FOUND;
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
  // Each segment is encoded on its own, so a directory named `a#b` or `50%` survives the URL.
  return route.subdir ? `${tree}/${route.subdir.split("/").map(encodeURIComponent).join("/")}` : tree;
}

export function routePath(route: Route): string {
  if (route.kind === "workspace") return `/w/${route.id}`;
  if (route.kind === "github") return githubPath(route);
  return "/";
}
