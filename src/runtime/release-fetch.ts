// Routes `bun install` downloads of public GitHub Release `.tgz` tarballs through Sprockt's
// same-origin Worker proxy (`/api/github/release/...` and `/api/github/release-latest/...`),
// because GitHub's release-asset CDN redirect lacks CORS/CORP headers under COEP (`require-corp`).
// GitHub release downloads use `packageFetch` directly so the browser's HTTP cache obeys the
// Worker's `Cache-Control` TTL (`max-age=300` for tagged assets, `no-store` for latest) instead
// of `installFetch`'s indefinite Cache Storage. All other fetches pass through `installFetch`
// unchanged.
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

export type GitHubReleaseTarball =
  | {
      readonly kind: "tag";
      readonly owner: string;
      readonly repo: string;
      readonly tag: string;
      readonly asset: string;
    }
  | {
      readonly kind: "latest";
      readonly owner: string;
      readonly repo: string;
      readonly asset: string;
    };

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
 * Parses a public GitHub Release `.tgz` URL (`.../releases/download/<tag>/<asset>.tgz` or
 * `.../releases/latest/download/<asset>.tgz`), returning `undefined` for any other host, query
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
  const [owner = "", repo = "", releases, fourth, ...rest] = segments;
  if (releases !== "releases" || !isOwnerName(owner) || !isRepoName(repo)) return undefined;
  if (fourth === "latest" && rest.length === 2 && rest[0] === "download") {
    const asset = rest[1] ?? "";
    return isReleaseAssetName(asset) ? { kind: "latest", owner, repo, asset } : undefined;
  }
  if (fourth !== "download" || rest.length < 2) return undefined;
  const asset = rest.at(-1) ?? "";
  const tag = rest.slice(0, -1).join("/");
  if (!isRefName(tag) || !isReleaseAssetName(asset)) return undefined;
  return { kind: "tag", owner, repo, tag, asset };
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
  const owner = encodeURIComponent(release.owner);
  const repo = encodeURIComponent(release.repo);
  const asset = encodeURIComponent(release.asset);
  if (release.kind === "latest") return `${origin}${prefix}/release-latest/${owner}/${repo}/${asset}`;
  return `${origin}${prefix}/release/${owner}/${repo}/${encodeRefPath(release.tag)}/${asset}`;
}

export interface RuntimeFetchOptions {
  readonly origin?: string;
  readonly prefix?: string;
  readonly baseFetch?: NetFetch;
  readonly releaseFetch?: NetFetch;
}

/** Network fetch policy for `installBunAdapters`, proxying public GitHub Release `.tgz` tarballs. */
export function createRuntimeFetch(options: RuntimeFetchOptions = {}): NetFetch {
  const prefix = options.prefix ?? DEFAULT_GITHUB_PROXY_PREFIX;
  const baseFetch = options.baseFetch ?? installFetch;
  const releaseFetch = options.releaseFetch ?? packageFetch;
  return (url: string, init: RequestInit): Promise<Response> => {
    const origin = options.origin ?? location.origin;
    const proxied = rewriteGitHubReleaseTarballUrl(url, init, { origin, prefix });
    return proxied ? releaseFetch(proxied, init) : baseFetch(url, init);
  };
}
