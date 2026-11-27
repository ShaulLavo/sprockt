/**
 * Cloudflare Worker routes that let the browser import public GitHub
 * repositories, which it cannot fetch directly because codeload.github.com
 * sends no CORS headers.
 *
 *   GET <prefix>/repo/<owner>/<repo>                        -> minimal metadata from api.github.com
 *   GET <prefix>/refs/<owner>/<repo>/<segment>              -> branch and tag names starting with <segment>
 *   GET <prefix>/archive/<owner>/<repo>/<ref>               -> codeload tar.gz, streamed through
 *   GET <prefix>/release/<owner>/<repo>/<tag>/<asset>.tgz   -> public GitHub Release .tgz, streamed through
 *   GET <prefix>/release-latest/<owner>/<repo>/<asset>.tgz  -> public GitHub latest Release .tgz, streamed through
 *
 * Nothing else is proxied: names are validated, upstream URLs are built from
 * fixed templates, and every redirect hop must stay on the route's own HTTPS
 * origin and path shape (or GitHub's official release-asset CDN hosts for
 * release tarballs). Request headers and cookies from the browser are
 * never forwarded. The optional `GITHUB_TOKEN` raises the API rate limit; it
 * is attached only to validated api.github.com requests, never to codeload or
 * release downloads, and private repositories are refused even when the token
 * could read them, so the proxy can only ever expose public code.
 */
import type { GitHubErrorCode, ProxyErrorBody, RepoInfo } from "../src/importer/github/errors.ts";
import {
  encodeRefPath,
  isCommitSha,
  isOwnerName,
  isRefComponent,
  isRefName,
  isReleaseAssetName,
  isRepoName,
} from "../src/importer/github/names.ts";
import type { MatchingRefs } from "../src/importer/github/source.ts";
import type { Fetch } from "../src/lib/bytes.ts";

/** Cloudflare's Workers rate limiting binding (`ratelimits` in wrangler.jsonc). */
export interface RateLimiter {
  limit(options: { readonly key: string }): Promise<{ readonly success: boolean }>;
}

export interface GitHubProxyEnv {
  /** Optional token for api.github.com (5000 instead of 60 requests an hour). Needs no scopes. */
  readonly GITHUB_TOKEN?: string;
  /** Largest archive passed through, in bytes. Defaults to 100 MiB. */
  readonly GITHUB_PROXY_MAX_ARCHIVE_BYTES?: string;
  /**
   * Limits the routes that spend GitHub API quota (`repo`, `refs`) per client address. Without
   * the binding (local dev, tests) those routes are unlimited.
   */
  readonly GITHUB_API_LIMITER?: RateLimiter;
}

export interface GitHubProxyOptions {
  /** Path prefix the routes are mounted under. */
  readonly prefix?: string;
  /** Upstream fetch, replaceable in tests. */
  readonly fetch?: Fetch;
}

export const GITHUB_PROXY_PREFIX = "/api/github";
const DEFAULT_MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const SHORT_CACHE = 300;
const MISSING_CACHE = 60;
const IMMUTABLE_CACHE = 365 * 24 * 60 * 60;
/** GitHub documents "wait at least one minute" for secondary limits that give no other hint. */
const SECONDARY_LIMIT_WAIT = 60;
/** Error bodies are small JSON; read at most this much when looking for a rate-limit message. */
const MAX_ERROR_BODY = 16 * 1024;
/** Repository metadata is a few KiB of JSON. */
const MAX_REPO_BODY = 256 * 1024;
/**
 * GitHub's matching-refs endpoint has no pagination, so a repository with many refs under one
 * prefix can answer with a large list. About 5,000 refs fit; past that the route refuses.
 */
const MAX_REFS_BODY = 1024 * 1024;
/** How long a client that hit the API limiter is told to wait. */
const LIMITER_WAIT = 60;
const USER_AGENT = "sprockt-github-proxy";

const API_ORIGIN = "https://api.github.com";
const CODELOAD_ORIGIN = "https://codeload.github.com";
const GITHUB_ORIGIN = "https://github.com";
const RELEASE_ASSET_ORIGINS = new Set([
  "https://release-assets.githubusercontent.com",
  "https://objects.githubusercontent.com",
  "https://objects-origin.githubusercontent.com",
]);
const RELEASE_ASSET_PATH_PREFIX = "/github-production-release-asset";
/** COEP-safe headers sent on every proxy response so same-origin browser fetches succeed under require-corp. */
const SECURITY_HEADERS = {
  "cross-origin-resource-policy": "same-origin",
  "x-content-type-options": "nosniff",
} as const;
/** A repository by name, or by id as GitHub's redirect for a renamed repository points. */
const API_REPO = String.raw`/(?:repos/[^/]+/[^/]+|repositories/\d+)`;
const REPO_PATH = new RegExp(`^${API_REPO}$`);
const REFS_PATH = new RegExp(`^${API_REPO}/git/matching-refs/(?:heads|tags)/[^/]+$`);
const ARCHIVE_PATH = /^\/[^/]+\/[^/]+\/tar\.gz\/.+$/;

/** Builds the route handler, `fetch(request, env)` style, for the deploy Worker to mount. */
export function createGitHubProxy(options: GitHubProxyOptions = {}) {
  const prefix = (options.prefix ?? GITHUB_PROXY_PREFIX).replace(/\/+$/, "");
  const upstream = options.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
  return async function handleGitHubProxy(request: Request, env: GitHubProxyEnv = {}): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(`${prefix}/`)) return errorResponse(404, "not-found", "No such route.");
    if (request.method !== "GET" && request.method !== "HEAD") {
      return errorResponse(405, "invalid-source", "Only GET and HEAD are supported.", { allow: "GET, HEAD" });
    }
    const segments = routeSegments(url.pathname.slice(prefix.length + 1));
    if (!segments) return errorResponse(400, "invalid-source", "The path is not valid.");
    const [route, owner = "", repo = "", ...rest] = segments;
    const invalid = validateNames(owner, repo);
    if (invalid) return invalid;
    const context: UpstreamContext = { fetch: upstream, env, method: request.method };
    if (route === "archive" && rest.length > 0) return archive(context, owner, repo, rest.join("/"));
    if (route === "release" && rest.length >= 2) {
      const asset = rest.at(-1) ?? "";
      const tag = rest.slice(0, -1).join("/");
      return releaseAsset(context, owner, repo, tag, asset);
    }
    if (route === "release-latest" && rest.length === 1) {
      return releaseLatestAsset(context, owner, repo, rest[0] ?? "");
    }
    const isApiRoute = (route === "repo" && rest.length === 0) || (route === "refs" && rest.length === 1);
    if (!isApiRoute) return errorResponse(404, "not-found", "No such route.");
    if (!(await withinApiLimit(request, env))) {
      const message = "Too many GitHub lookups from this address. Try again in a minute.";
      return errorResponse(
        429,
        "rate-limited",
        message,
        { "retry-after": String(LIMITER_WAIT) },
        LIMITER_WAIT,
      );
    }
    if (route === "repo") return repoInfo(context, owner, repo);
    return matchingRefs(context, owner, repo, rest[0] ?? "");
  };
}

/** Whether this client may spend more GitHub API quota; always true without a limiter binding. */
async function withinApiLimit(request: Request, env: GitHubProxyEnv): Promise<boolean> {
  if (!env.GITHUB_API_LIMITER) return true;
  const key = request.headers.get("cf-connecting-ip") ?? "unknown";
  const { success } = await env.GITHUB_API_LIMITER.limit({ key });
  return success;
}

interface UpstreamContext {
  readonly fetch: Fetch;
  readonly env: GitHubProxyEnv;
  readonly method: string;
}

function routeSegments(path: string): string[] | undefined {
  try {
    return path
      .split("/")
      .filter((segment) => segment !== "")
      .map((segment) => decodeURIComponent(segment));
  } catch {
    return undefined;
  }
}

function validateNames(owner: string, repo: string): Response | undefined {
  if (!isOwnerName(owner))
    return errorResponse(400, "invalid-source", `"${owner}" is not a valid owner name.`);
  if (!isRepoName(repo))
    return errorResponse(400, "invalid-source", `"${repo}" is not a valid repository name.`);
  return undefined;
}

interface GitHubRepoBody {
  readonly name?: string;
  readonly private?: boolean;
  readonly default_branch?: string;
  readonly size?: number;
  readonly owner?: { readonly login?: string };
}

/** The repository's metadata if it is public, otherwise the error response to send. */
async function publicRepo(
  context: UpstreamContext,
  owner: string,
  repo: string,
): Promise<GitHubRepoBody | Response> {
  const name = `${owner}/${repo}`;
  const response = await fetchApi(context, `${API_ORIGIN}/repos/${owner}/${repo}`, REPO_PATH);
  if (!response) return errorResponse(502, "upstream", "GitHub redirected somewhere unexpected.");
  if (response.status === 404)
    return errorResponse(404, "not-found", `${name} was not found, or it is private.`);
  if (!response.ok) return upstreamError(response, name);
  const body = await readJson(response, MAX_REPO_BODY);
  if (!isObject(body)) return errorResponse(502, "upstream", `GitHub sent unreadable metadata for ${name}.`);
  const repoBody = body as GitHubRepoBody;
  if (repoBody.private !== false) {
    return errorResponse(403, "private", `${name} is private. Only public repositories can be imported.`);
  }
  return repoBody;
}

async function repoInfo(context: UpstreamContext, owner: string, repo: string): Promise<Response> {
  const body = await publicRepo(context, owner, repo);
  if (body instanceof Response) return body;
  const info: RepoInfo = {
    owner: body.owner?.login ?? owner,
    repo: body.name ?? repo,
    defaultBranch: body.default_branch ?? "main",
    sizeKiB: body.size ?? 0,
  };
  return Response.json(info, {
    headers: { "cache-control": `public, max-age=${SHORT_CACHE}`, ...SECURITY_HEADERS },
  });
}

/**
 * Branches and tags whose names start with `segment`, so the importer can tell
 * where the ref ends in `/tree/feature/x/src` before downloading anything.
 */
async function matchingRefs(
  context: UpstreamContext,
  owner: string,
  repo: string,
  segment: string,
): Promise<Response> {
  if (!isRefComponent(segment))
    return errorResponse(400, "invalid-source", `"${segment}" is not a valid branch or tag.`);
  const publicCheck = await publicRepo(context, owner, repo);
  if (publicCheck instanceof Response) return publicCheck;
  const [branches, tags] = await Promise.all([
    refNames(context, owner, repo, "heads", segment),
    refNames(context, owner, repo, "tags", segment),
  ]);
  if (branches instanceof Response) return branches;
  if (tags instanceof Response) return tags;
  const refs: MatchingRefs = { branches, tags };
  return Response.json(refs, {
    headers: { "cache-control": `public, max-age=${SHORT_CACHE}`, ...SECURITY_HEADERS },
  });
}

async function refNames(
  context: UpstreamContext,
  owner: string,
  repo: string,
  kind: "heads" | "tags",
  segment: string,
): Promise<string[] | Response> {
  const url = `${API_ORIGIN}/repos/${owner}/${repo}/git/matching-refs/${kind}/${encodeURIComponent(segment)}`;
  const response = await fetchApi(context, url, REFS_PATH);
  if (!response) return errorResponse(502, "upstream", "GitHub redirected somewhere unexpected.");
  // An empty repository answers 409; it simply has no refs.
  if (response.status === 404 || response.status === 409) return [];
  if (!response.ok) return upstreamError(response, `${owner}/${repo}`);
  const body = await readJson(response, MAX_REFS_BODY);
  if (body === TOO_LARGE) {
    return errorResponse(502, "upstream", `Too many branches or tags start with "${segment}" to list.`);
  }
  if (!Array.isArray(body)) return errorResponse(502, "upstream", "GitHub sent an unreadable ref list.");
  const prefix = `refs/${kind}/`;
  return body
    .map((item: unknown) => (isObject(item) && typeof item.ref === "string" ? item.ref : ""))
    .filter((ref) => ref.startsWith(prefix))
    .map((ref) => ref.slice(prefix.length));
}

async function archive(
  context: UpstreamContext,
  owner: string,
  repo: string,
  ref: string,
): Promise<Response> {
  if (!isRefName(ref))
    return errorResponse(400, "invalid-source", `"${ref}" is not a valid branch, tag or commit.`);
  const ttl = isCommitSha(ref) ? IMMUTABLE_CACHE : SHORT_CACHE;
  const response = await fetchUpstream(
    context,
    `${CODELOAD_ORIGIN}/${owner}/${repo}/tar.gz/${encodeRefPath(ref)}`,
    {
      origin: CODELOAD_ORIGIN,
      path: ARCHIVE_PATH,
      headers: { "user-agent": USER_AGENT },
      cf: cacheByStatus(ttl),
    },
  );
  const name = `${owner}/${repo}`;
  if (!response) return errorResponse(502, "upstream", "GitHub redirected somewhere unexpected.");
  if (response.status === 404) {
    return errorResponse(
      404,
      "not-found",
      `${name} has no branch, tag or commit "${ref}", or it is private.`,
    );
  }
  if (!response.ok || !response.body) return upstreamError(response, name);
  const limit = maxArchiveBytes(context.env);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > limit) {
    await response.body.cancel();
    return errorResponse(
      413,
      "too-large",
      `${name} is larger than the ${Math.round(limit / 1048576)} MiB import limit.`,
    );
  }
  const headers = new Headers({
    "content-type": "application/gzip",
    "cache-control": ttl === IMMUTABLE_CACHE ? `public, max-age=${ttl}, immutable` : `public, max-age=${ttl}`,
    ...SECURITY_HEADERS,
  });
  if (context.method === "HEAD") {
    await response.body.cancel();
    return new Response(null, { status: 200, headers });
  }
  // With a declared length within the limit, pass the upstream body through untouched so the
  // runtime keeps its length; only an unsized body needs the counting stream.
  const body = declared > 0 ? response.body : response.body.pipeThrough(byteLimit(limit));
  return new Response(body, { status: 200, headers });
}

async function releaseAsset(
  context: UpstreamContext,
  owner: string,
  repo: string,
  tag: string,
  asset: string,
): Promise<Response> {
  if (!isRefName(tag)) return errorResponse(400, "invalid-source", `"${tag}" is not a valid release tag.`);
  if (!isReleaseAssetName(asset)) {
    return errorResponse(400, "invalid-source", `"${asset}" is not a valid .tgz release asset.`);
  }
  const url = `${GITHUB_ORIGIN}/${owner}/${repo}/releases/download/${encodeRefPath(tag)}/${encodeURIComponent(asset)}`;
  return streamReleaseAsset(context, `${owner}/${repo}`, asset, tag, url);
}

async function releaseLatestAsset(
  context: UpstreamContext,
  owner: string,
  repo: string,
  asset: string,
): Promise<Response> {
  if (!isReleaseAssetName(asset)) {
    return errorResponse(400, "invalid-source", `"${asset}" is not a valid .tgz release asset.`);
  }
  const url = `${GITHUB_ORIGIN}/${owner}/${repo}/releases/latest/download/${encodeURIComponent(asset)}`;
  return streamReleaseAsset(context, `${owner}/${repo}`, asset, "latest", url);
}

async function streamReleaseAsset(
  context: UpstreamContext,
  name: string,
  asset: string,
  label: string,
  url: string,
): Promise<Response> {
  const response = await fetchReleaseUpstream(context, url);
  if (!response) return errorResponse(502, "upstream", "GitHub redirected somewhere unexpected.");
  if (response.status === 404) {
    return errorResponse(
      404,
      "not-found",
      `${name} has no release asset "${asset}" on "${label}", or it is private.`,
    );
  }
  if (!response.ok || !response.body) return upstreamError(response, name);
  const limit = maxArchiveBytes(context.env);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > limit) {
    await response.body.cancel();
    return errorResponse(
      413,
      "too-large",
      `${asset} is larger than the ${Math.round(limit / 1048576)} MiB download limit.`,
    );
  }
  const headers = new Headers({
    "content-type": "application/gzip",
    "cache-control": `public, max-age=${SHORT_CACHE}`,
    ...SECURITY_HEADERS,
  });
  if (context.method === "HEAD") {
    await response.body.cancel();
    return new Response(null, { status: 200, headers });
  }
  // Always enforce the byte limit on release streams, even if upstream under-reports content-length.
  const body = response.body.pipeThrough(byteLimit(limit));
  return new Response(body, { status: 200, headers });
}

function parseUrl(input: string, base?: URL): URL | undefined {
  try {
    return new URL(input, base);
  } catch {
    return undefined;
  }
}

function isAllowedGitHubReleasePath(pathname: string): boolean {
  const segments = routeSegments(pathname);
  if (!segments || segments.length < 6) return false;
  const [owner = "", repo = "", releases, fourth, ...rest] = segments;
  if (releases !== "releases" || !isOwnerName(owner) || !isRepoName(repo)) return false;
  if (fourth === "latest" && rest.length === 2 && rest[0] === "download") {
    return isReleaseAssetName(rest[1] ?? "");
  }
  if (fourth !== "download" || rest.length < 2) return false;
  const asset = rest.at(-1) ?? "";
  const tag = rest.slice(0, -1).join("/");
  return isRefName(tag) && isReleaseAssetName(asset);
}

function isAllowedReleaseAssetPath(pathname: string): boolean {
  if (!pathname.startsWith(RELEASE_ASSET_PATH_PREFIX)) return false;
  return !pathname.split("/").some((segment) => segment === "." || segment === "..");
}

function isAllowedReleaseHop(target: URL, onAssetHost: boolean): boolean {
  if (
    target.protocol !== "https:" ||
    target.username !== "" ||
    target.password !== "" ||
    target.port !== ""
  ) {
    return false;
  }
  if (RELEASE_ASSET_ORIGINS.has(target.origin)) return isAllowedReleaseAssetPath(target.pathname);
  if (onAssetHost || target.origin !== GITHUB_ORIGIN || target.search !== "") return false;
  return isAllowedGitHubReleasePath(target.pathname);
}

/**
 * Fetches a public GitHub release `.tgz` with manual redirects. Only `https://github.com` release
 * download URLs and GitHub's official release-asset CDN hosts may be visited; no auth token or
 * browser headers are ever sent, and signed redirects are not subrequest-cached.
 */
async function fetchReleaseUpstream(context: UpstreamContext, url: string): Promise<Response | undefined> {
  let target = parseUrl(url);
  let onAssetHost = false;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!target || !isAllowedReleaseHop(target, onAssetHost)) return undefined;
    const init: RequestInit = {
      method: "GET",
      redirect: "manual",
      headers: { "user-agent": USER_AGENT },
    };
    // Each hop depends on the Location of the one before it.
    // oxlint-disable-next-line no-await-in-loop
    const response = await context.fetch(target.toString(), init);
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) return response;
    void response.body?.cancel().catch(() => undefined);
    onAssetHost = onAssetHost || RELEASE_ASSET_ORIGINS.has(target.origin);
    target = parseUrl(location, target);
  }
  return undefined;
}

function maxArchiveBytes(env: GitHubProxyEnv): number {
  const configured = Number(env.GITHUB_PROXY_MAX_ARCHIVE_BYTES);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_ARCHIVE_BYTES;
}

/** Cuts the stream off once it passes `limit` bytes, for archives sent without a length. */
function byteLimit(limit: number): TransformStream<Uint8Array, Uint8Array> {
  let total = 0;
  return new TransformStream({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > limit) {
        controller.error(new Error(`archive is larger than ${limit} bytes`));
        return;
      }
      controller.enqueue(chunk);
    },
  });
}

/** Cloudflare's subrequest cache: successes for `ttl`, misses briefly, server errors never. */
interface CacheOptions {
  readonly cacheEverything: boolean;
  readonly cacheTtlByStatus: Readonly<Record<string, number>>;
}

function cacheByStatus(ttl: number): CacheOptions {
  return { cacheEverything: true, cacheTtlByStatus: { "200-299": ttl, "404": MISSING_CACHE, "500-599": 0 } };
}

interface UpstreamPolicy {
  /** The only origin any hop may use. */
  readonly origin: string;
  /** The path shape every hop must match. */
  readonly path: RegExp;
  readonly headers: Readonly<Record<string, string>>;
  readonly cf?: CacheOptions;
}

function fetchApi(context: UpstreamContext, url: string, path: RegExp): Promise<Response | undefined> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": USER_AGENT,
    "x-github-api-version": "2022-11-28",
  };
  const token = context.env.GITHUB_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  // Authenticated responses are not put in the shared subrequest cache: only the validated,
  // public result this Worker builds is cacheable (by its own Cache-Control).
  return fetchUpstream(context, url, {
    origin: API_ORIGIN,
    path,
    headers,
    cf: token ? undefined : cacheByStatus(SHORT_CACHE),
  });
}

/**
 * Fetches with manual redirects. Every hop, the first included, must be on the
 * policy's origin and match its path shape; `undefined` when one is not. The
 * policy's headers (and so the token) therefore never reach another host.
 */
async function fetchUpstream(
  context: UpstreamContext,
  url: string,
  policy: UpstreamPolicy,
): Promise<Response | undefined> {
  let target = new URL(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (target.origin !== policy.origin || !policy.path.test(target.pathname) || target.search !== "")
      return undefined;
    const init: RequestInit & { cf?: CacheOptions } = {
      method: "GET",
      redirect: "manual",
      headers: policy.headers,
    };
    if (policy.cf) init.cf = policy.cf;
    // Each hop depends on the Location of the one before it.
    // oxlint-disable-next-line no-await-in-loop
    const response = await context.fetch(target.toString(), init);
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) return response;
    void response.body?.cancel().catch(() => undefined);
    target = new URL(location, target);
  }
  return undefined;
}

async function upstreamError(response: Response, name: string): Promise<Response> {
  const retryAfter = await rateLimitWait(response);
  if (retryAfter === undefined) {
    if (!response.bodyUsed) await response.body?.cancel();
    return errorResponse(502, "upstream", `GitHub answered ${response.status} for ${name}.`);
  }
  const message = "GitHub is rate limiting imports. Try again in a few minutes.";
  return errorResponse(429, "rate-limited", message, { "retry-after": String(retryAfter) }, retryAfter);
}

/**
 * Seconds to wait when the response is a rate limit, otherwise `undefined`.
 * Follows GitHub's documented order: `retry-after`, then an exhausted primary
 * quota's reset time, then a minute for a secondary limit that gives neither.
 */
async function rateLimitWait(response: Response): Promise<number | undefined> {
  if (response.status !== 403 && response.status !== 429) return undefined;
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.ceil(retryAfter);
  if (response.headers.get("x-ratelimit-remaining") === "0") return resetWait(response);
  if (response.status === 429) return SECONDARY_LIMIT_WAIT;
  const text = await readText(response, MAX_ERROR_BODY);
  return /secondary rate limit|abuse detection|rate limit exceeded/i.test(text)
    ? SECONDARY_LIMIT_WAIT
    : undefined;
}

function resetWait(response: Response): number {
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  if (!Number.isFinite(reset) || reset <= 0) return SECONDARY_LIMIT_WAIT;
  return Math.max(1, Math.ceil(reset - Date.now() / 1000));
}

interface BoundedText {
  readonly text: string;
  /** False when the body was longer than the limit and reading stopped there. */
  readonly complete: boolean;
}

/** Reads at most `limit` bytes of a body, then lets the rest go. */
async function readBounded(response: Response, limit: number): Promise<BoundedText> {
  if (!response.body) return { text: "", complete: true };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let complete = true;
  // Chunks arrive one after another; there is nothing to run in parallel.
  // oxlint-disable-next-line no-await-in-loop
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    bytes += next.value.byteLength;
    if (bytes > limit) {
      complete = false;
      break;
    }
    text += decoder.decode(next.value, { stream: true });
  }
  await reader.cancel().catch(() => undefined);
  reader.releaseLock();
  return { text: text + decoder.decode(), complete };
}

async function readText(response: Response, limit: number): Promise<string> {
  return (await readBounded(response, limit)).text;
}

/** Marks a JSON body that was larger than the caller's limit. */
const TOO_LARGE = Symbol("too large");

async function readJson(response: Response, limit: number): Promise<unknown> {
  const { text, complete } = await readBounded(response, limit);
  if (!complete) return TOO_LARGE;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorResponse(
  status: number,
  error: GitHubErrorCode,
  message: string,
  headers: Record<string, string> = {},
  retryAfter?: number,
): Response {
  const body: ProxyErrorBody = retryAfter === undefined ? { error, message } : { error, message, retryAfter };
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", ...SECURITY_HEADERS, ...headers },
  });
}
