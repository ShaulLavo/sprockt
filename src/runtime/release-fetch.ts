// Routes `bun install` downloads of public GitHub Release `.tgz` tarballs through Sprockt's
// same-origin Worker proxy (`/api/github/release/...`), because GitHub's release-asset CDN
// redirect lacks CORS/CORP headers under COEP (`require-corp`). All other fetches pass through
// `bun-wasm`'s `installFetch` unchanged (preserving its Cache Storage tarball cache).
import type { NetFetch } from "waffle/browser/net/helper";
import { installFetch } from "../../node_modules/bun-wasm/web/src/net/install-cache.ts";
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
 * Parses a public GitHub Release `.tgz` URL (`https://github.com/<owner>/<repo>/releases/download/<tag>/<asset>.tgz`),
 * returning `undefined` for any other host, query string, credentials, or invalid path component.
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
  if (releases !== "releases" || download !== "download") return undefined;
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
 * targeting a public GitHub Release `.tgz` asset, or `undefined` when the request should pass
 * straight through untouched.
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
  return `${origin}${prefix}/release/${encodeURIComponent(release.owner)}/${encodeURIComponent(release.repo)}/${encodeRefPath(release.tag)}/${encodeURIComponent(release.asset)}`;
}

export interface RuntimeFetchOptions {
  readonly origin?: string;
  readonly prefix?: string;
  readonly baseFetch?: NetFetch;
}

/** Network fetch policy for `installBunAdapters`, proxying public GitHub Release `.tgz` tarballs. */
export function createRuntimeFetch(options: RuntimeFetchOptions = {}): NetFetch {
  const prefix = options.prefix ?? DEFAULT_GITHUB_PROXY_PREFIX;
  const baseFetch = options.baseFetch ?? installFetch;
  return (url: string, init: RequestInit): Promise<Response> => {
    const origin = options.origin ?? location.origin;
    const proxied = rewriteGitHubReleaseTarballUrl(url, init, { origin, prefix });
    return baseFetch(proxied ?? url, init);
  };
}
