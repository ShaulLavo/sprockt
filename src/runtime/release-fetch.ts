// Routes `bun install` downloads of public tagged GitHub Release `.tgz` tarballs through
// Sprockt's same-origin Worker proxy (`/api/github/release/<owner>/<repo>/<tag>/<asset>.tgz`),
// because GitHub's release-asset CDN redirect lacks CORS/CORP headers under COEP (`require-corp`).
// Only tagged release URLs are proxied: mutable `/releases/latest/download/` URLs are excluded
// because `bun-wasm`'s per-workspace guest tarball cache (`~/.bun/install/cache/bun-wasm`) keys
// tarballs by URL until `bun install --no-cache` (matching desktop Bun). Tagged release fetches
// use `packageFetch` directly (instead of `installFetch`'s indefinite Cache Storage) so the
// shared browser HTTP cache honors the Worker's 5-minute TTL for fresh workspaces and bypasses
// HTTP cache with `cache: "reload"` on `--no-cache`; all other requests pass through `installFetch`.
import type { NetFetch } from "waffle/browser/net/helper";
import { installFetch } from "../../node_modules/bun-wasm/web/src/net/install-cache.ts";
import { packageFetch } from "../../node_modules/bun-wasm/web/src/net/package-fetch.ts";
import {
  encodeRefPath,
  isOwnerName,
  isRefName,
  isReleaseAssetName,
  isRepoName,
} from "../importer/github/names";

export const DEFAULT_GITHUB_PROXY_PREFIX = "/api/github";
const INSTALL_TARBALL_ACCEPT = "application/vnd.bun.install-tarball";

export interface GitHubReleaseTarball {
  readonly owner: string;
  readonly repo: string;
  readonly tag: string;
  readonly asset: string;
}

function decodeSegments(pathname: string): string[] | undefined {
  try {
    return pathname
      .split("/")
      .filter((segment) => segment !== "")
      .map((segment) => decodeURIComponent(segment));
  } catch {
    return undefined;
  }
}

/**
 * Parses a public tagged GitHub Release `.tgz` URL (`https://github.com/<owner>/<repo>/releases/download/<tag>/<asset>.tgz`),
 * returning `undefined` for any other host, mutable `/releases/latest/download/` URL, query
 * string, credentials, or invalid path component.
 */
export function parseGitHubReleaseTarballUrl(input: string): GitHubReleaseTarball | undefined {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== ""
  ) {
    return undefined;
  }
  const segments = decodeSegments(url.pathname);
  if (!segments || segments.length < 6) return undefined;
  const [owner = "", repo = "", releases, download, ...rest] = segments;
  if (releases !== "releases" || download !== "download" || rest.length < 2) return undefined;
  const asset = rest.at(-1) ?? "";
  const tag = rest.slice(0, -1).join("/");
  if (!isOwnerName(owner) || !isRepoName(repo) || !isRefName(tag) || !isReleaseAssetName(asset)) {
    return undefined;
  }
  return { owner, repo, tag, asset };
}

export interface RewriteConfig {
  readonly origin: string;
  readonly prefix?: string;
}

/**
 * Returns Sprockt's same-origin proxy URL for an unauthenticated `bun install` tarball request
 * targeting a public tagged GitHub Release `.tgz` asset, or `undefined` when the request should
 * pass straight through untouched.
 */
export function rewriteGitHubReleaseTarballUrl(
  url: string,
  options: RequestInit,
  config: RewriteConfig,
): string | undefined {
  const method = (options.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") return undefined;
  const headers = new Headers(options.headers);
  if (headers.has("authorization")) return undefined;
  const accept = (headers.get("accept") ?? "").split(";", 1)[0]?.trim().toLowerCase();
  if (accept !== INSTALL_TARBALL_ACCEPT) return undefined;
  const release = parseGitHubReleaseTarballUrl(url);
  if (!release) return undefined;
  const origin = config.origin.replace(/\/+$/, "");
  const prefix = (config.prefix ?? DEFAULT_GITHUB_PROXY_PREFIX).replace(/\/+$/, "");
  const owner = encodeURIComponent(release.owner);
  const repo = encodeURIComponent(release.repo);
  const asset = encodeURIComponent(release.asset);
  return `${origin}${prefix}/release/${owner}/${repo}/${encodeRefPath(release.tag)}/${asset}`;
}

export interface RuntimeFetchOptions {
  readonly origin?: string;
  readonly prefix?: string;
  readonly baseFetch?: NetFetch;
  readonly releaseFetch?: NetFetch;
}

function wantsFreshTarball(init: RequestInit): boolean {
  const headers = new Headers(init.headers);
  const accept = (headers.get("accept") ?? "").toLowerCase();
  if (accept.includes("; no-cache")) return true;
  const cacheControl = headers.get("cache-control");
  if (!cacheControl) return false;
  return cacheControl.split(",").some((directive) => directive.trim().toLowerCase() === "no-cache");
}

/** Network fetch policy for `installBunAdapters`, proxying public tagged GitHub Release `.tgz` tarballs. */
export function createRuntimeFetch(options: RuntimeFetchOptions = {}): NetFetch {
  const prefix = options.prefix ?? DEFAULT_GITHUB_PROXY_PREFIX;
  const baseFetch = options.baseFetch ?? installFetch;
  const releaseFetch = options.releaseFetch ?? packageFetch;
  return (url: string, init: RequestInit): Promise<Response> => {
    const origin = options.origin ?? location.origin;
    const proxied = rewriteGitHubReleaseTarballUrl(url, init, { origin, prefix });
    if (!proxied) return baseFetch(url, init);
    const releaseInit = wantsFreshTarball(init) ? { ...init, cache: "reload" as const } : init;
    return releaseFetch(proxied, releaseInit);
  };
}
