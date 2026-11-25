import { firstSegment, normalizePath } from "../../lib/fs/path.ts";
import type { FileEntry } from "../../lib/fs/types.ts";
import { decompressionStream, defaultFetch, type Fetch } from "../../lib/bytes.ts";
import { GitHubImportError, type ProxyErrorBody, type RepoInfo } from "./errors.ts";
import { encodeRefPath, isCommitSha, isRefName } from "./names.ts";
import { chooseSplit, refCandidates, type GitHubSource, type MatchingRefs, type RefSplit } from "./source.ts";
import { readTar, TarError, type TarHeader } from "./tar.ts";

export interface ImportLimits {
  /** Compressed archive bytes downloaded. */
  readonly maxArchiveBytes: number;
  /** Unpacked bytes of the files kept. */
  readonly maxTotalBytes: number;
  /** Every decompressed byte read, including files outside the subfolder, headers and padding. */
  readonly maxScannedBytes: number;
  readonly maxFiles: number;
}

export const DEFAULT_IMPORT_LIMITS: ImportLimits = {
  maxArchiveBytes: 100 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxScannedBytes: 1024 * 1024 * 1024,
  maxFiles: 20_000,
};

export interface ImportOptions {
  /** Base URL of the proxy routes (see `worker/github-proxy.ts`). */
  readonly apiBase?: string;
  readonly fetch?: Fetch;
  readonly limits?: Partial<ImportLimits>;
  readonly signal?: AbortSignal;
  /** Called as the import moves along; `downloading` repeats as bytes arrive. */
  readonly onProgress?: (progress: ImportProgress) => void;
}

export type ImportProgress =
  | { readonly stage: "resolving" }
  | { readonly stage: "downloading"; readonly bytes: number; readonly files: number };

export interface ImportResult {
  readonly owner: string;
  readonly repo: string;
  /** The branch, tag or commit the archive was made from. */
  readonly ref: string;
  /** The commit id `git archive` recorded, when present. */
  readonly commit: string | undefined;
  /** The subdirectory imported, `""` for the whole repository. Entry paths are relative to it. */
  readonly subdir: string;
  readonly files: FileEntry[];
  /** Entries left out: symlinks, hardlinks and special files. */
  readonly skipped: number;
}

/**
 * Downloads a GitHub repository through the proxy and unpacks it in memory.
 * Throws `GitHubImportError` with a code and a human-readable message.
 */
export async function importGitHubRepo(
  source: GitHubSource,
  options: ImportOptions = {},
): Promise<ImportResult> {
  const context: Context = {
    base: (options.apiBase ?? "/api/github").replace(/\/+$/, ""),
    fetch: options.fetch ?? defaultFetch,
    limits: { ...DEFAULT_IMPORT_LIMITS, ...options.limits },
    signal: options.signal,
    source,
    progress: options.onProgress ?? noProgress,
  };
  context.progress({ stage: "resolving" });
  const split = await resolveSplit(context);
  const response = await request(context, archiveUrl(context, split.fetchRef));
  if (!response.ok) throw await responseError(response, context);
  return unpack(context, split, response);
}

/** Fetches repository metadata (default branch, size) through the proxy. */
export async function fetchRepoInfo(
  owner: string,
  repo: string,
  options: Omit<ImportOptions, "limits"> = {},
): Promise<RepoInfo> {
  const base = (options.apiBase ?? "/api/github").replace(/\/+$/, "");
  const context: Context = {
    base,
    fetch: options.fetch ?? defaultFetch,
    limits: DEFAULT_IMPORT_LIMITS,
    signal: options.signal,
    source: { owner, repo, refAndPath: [], target: "tree" },
    progress: noProgress,
  };
  const url = `${base}/repo/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const info = await requestJson(context, url);
  if (!isObject(info) || typeof info.defaultBranch !== "string" || !isRefName(info.defaultBranch)) {
    throw new GitHubImportError("upstream", `GitHub sent unreadable metadata for ${owner}/${repo}.`);
  }
  return info as unknown as RepoInfo;
}

interface Context {
  readonly base: string;
  readonly fetch: Fetch;
  readonly limits: ImportLimits;
  readonly signal: AbortSignal | undefined;
  readonly source: GitHubSource;
  readonly progress: (progress: ImportProgress) => void;
}

function noProgress(): void {}

type ResolvedSplit = RefSplit & { readonly fetchRef: string };

/** An abbreviated or full commit id, as GitHub puts in `/tree/<sha>/...` links. */
const COMMIT_PREFIX = /^[0-9a-f]{7,40}$/i;

/**
 * Works out which ref to download before downloading anything.
 * - `refs/heads/...` and `refs/tags/...` links name their namespace, and the
 *   ref is looked up only there.
 * - A single candidate or a full commit id needs no lookup.
 * - Otherwise the proxy lists the branches and tags starting with the first
 *   segment and the longest existing one wins, so a `feature` tag cannot mask
 *   the `feature/x` branch. When none exists, a hex first segment is taken as
 *   an abbreviated commit id.
 */
async function resolveSplit(context: Context): Promise<ResolvedSplit> {
  const { owner, repo, refAndPath } = context.source;
  if (refAndPath.length === 0) {
    const info = await fetchRepoInfo(owner, repo, {
      apiBase: context.base,
      fetch: context.fetch,
      signal: context.signal,
    });
    return { ref: info.defaultBranch, subdir: "", fetchRef: info.defaultBranch };
  }
  const namespace = qualifiedNamespace(refAndPath);
  const segments = namespace ? refAndPath.slice(2) : refAndPath;
  const splits = refCandidates({ ...context.source, refAndPath: segments });
  const [first] = splits;
  const lookup = segments[0] ?? "";
  if (!first) throw new GitHubImportError("invalid-source", "That link does not name a valid branch or tag.");
  if (!namespace && isCommitSha(lookup)) return { ...first, fetchRef: first.ref };
  if (splits.length === 1)
    return { ...first, fetchRef: namespace ? `refs/${namespace}/${first.ref}` : first.ref };
  const refs = await requestJson(context, refsUrl(context, lookup));
  if (!isMatchingRefs(refs))
    throw new GitHubImportError("upstream", "GitHub sent an unreadable list of branches.");
  const chosen = chooseSplit(splits, inNamespace(refs, namespace));
  if (chosen) return chosen;
  if (!namespace && first.ref === lookup && COMMIT_PREFIX.test(lookup)) return { ...first, fetchRef: lookup };
  throw new GitHubImportError(
    "not-found",
    `${owner}/${repo} has no branch or tag matching "${refAndPath.join("/")}".`,
  );
}

/** `heads` or `tags` for a fully qualified `refs/heads/...` or `refs/tags/...` link. */
function qualifiedNamespace(segments: readonly string[]): "heads" | "tags" | undefined {
  if (segments[0] !== "refs" || segments.length < 3) return undefined;
  const kind = segments[1];
  return kind === "heads" || kind === "tags" ? kind : undefined;
}

function inNamespace(refs: MatchingRefs, namespace: "heads" | "tags" | undefined): MatchingRefs {
  if (namespace === "heads") return { branches: refs.branches, tags: [] };
  if (namespace === "tags") return { branches: [], tags: refs.tags };
  return refs;
}

function isNames(names: unknown): boolean {
  return Array.isArray(names) && names.every((name) => typeof name === "string");
}

function isMatchingRefs(value: unknown): value is MatchingRefs {
  return isObject(value) && isNames(value.branches) && isNames(value.tags);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function repoPath(context: Context): string {
  const { owner, repo } = context.source;
  return `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function refsUrl(context: Context, segment: string): string {
  return `${context.base}/refs/${repoPath(context)}/${encodeURIComponent(segment)}`;
}

function archiveUrl(context: Context, ref: string): string {
  return `${context.base}/archive/${repoPath(context)}/${encodeRefPath(ref)}`;
}

async function requestJson(context: Context, url: string): Promise<unknown> {
  const response = await request(context, url);
  if (!response.ok) throw await responseError(response, context);
  return response.json().catch(() => undefined);
}

async function request(context: Context, url: string): Promise<Response> {
  try {
    return await context.fetch(url, { signal: context.signal });
  } catch (error) {
    if (context.signal?.aborted) throw error;
    throw new GitHubImportError("network", "Could not reach GitHub. Check your connection and try again.");
  }
}

async function responseError(response: Response, context: Context): Promise<GitHubImportError> {
  const body = (await response.json().catch(() => undefined)) as Partial<ProxyErrorBody> | undefined;
  const name = `${context.source.owner}/${context.source.repo}`;
  if (body?.error && body.message) return new GitHubImportError(body.error, body.message, body.retryAfter);
  if (response.status === 404) {
    return new GitHubImportError("not-found", `${name} was not found, or it is private.`);
  }
  if (response.status === 429) {
    return new GitHubImportError(
      "rate-limited",
      "GitHub is rate limiting imports. Try again in a few minutes.",
    );
  }
  if (response.status === 413) return new GitHubImportError("too-large", `${name} is too large to import.`);
  return new GitHubImportError("upstream", `GitHub answered ${response.status} for ${name}.`);
}

async function unpack(context: Context, split: RefSplit, response: Response): Promise<ImportResult> {
  if (!response.body) throw new GitHubImportError("bad-archive", "GitHub sent an empty archive.");
  const declared = Number(response.headers.get("content-length") ?? "0");
  const { limits, source } = context;
  if (declared > limits.maxArchiveBytes) throw tooLarge(source, limits.maxArchiveBytes);
  const counter = new UnpackCounter(context, split.subdir);
  let commit: string | undefined;
  const downloaded = (bytes: number) =>
    context.progress({ stage: "downloading", bytes, files: counter.files.length });
  const stream = response.body
    .pipeThrough(
      byteLimit(limits.maxArchiveBytes, () => tooLarge(source, limits.maxArchiveBytes), downloaded),
    )
    .pipeThrough(decompressionStream("gzip"))
    .pipeThrough(
      byteLimit(limits.maxScannedBytes, () => tooLarge(source, limits.maxScannedBytes, "unpacks to")),
    );
  try {
    const entries = readTar(stream, {
      accept: (header) => counter.accept(header),
      onGlobal: (records) => {
        commit = records.get("comment") ?? commit;
      },
    });
    for await (const entry of entries) counter.add(entry);
  } catch (error) {
    throw archiveError(error);
  }
  if (split.subdir !== "" && counter.files.length === 0) {
    throw new GitHubImportError(
      "subdir-not-found",
      `${source.owner}/${source.repo} has no folder "${split.subdir}" on ${split.ref}.`,
    );
  }
  return {
    owner: source.owner,
    repo: source.repo,
    ref: split.ref,
    commit,
    subdir: split.subdir,
    files: counter.files,
    skipped: counter.skipped,
  };
}

function archiveError(error: unknown): unknown {
  if (error instanceof GitHubImportError) return error;
  if (error instanceof TarError)
    return new GitHubImportError("bad-archive", `The archive is damaged: ${error.message}`);
  if (error instanceof TypeError)
    return new GitHubImportError("bad-archive", "The archive is not valid gzip data.");
  return error;
}

function tooLarge(source: GitHubSource, limit: number, verb = "is larger than"): GitHubImportError {
  const mib = Math.max(1, Math.round(limit / (1024 * 1024)));
  const more = verb === "is larger than" ? "Try importing a subfolder." : "It is too large to import.";
  const amount = verb === "is larger than" ? `the ${mib} MiB import limit` : `more than ${mib} MiB`;
  return new GitHubImportError("too-large", `${source.owner}/${source.repo} ${verb} ${amount}. ${more}`);
}

/** Decides which tar entries to keep and enforces the unpacked limits before any body is read. */
class UnpackCounter {
  readonly files: FileEntry[] = [];
  skipped = 0;
  #bytes = 0;
  readonly #prefix: string;
  /** The archive's single top-level directory (`<repo>-<sha>`), taken from its first entry. */
  #root: string | undefined;

  constructor(
    private readonly context: Context,
    subdir: string,
  ) {
    this.#prefix = subdir === "" ? "" : `${subdir}/`;
  }

  /**
   * The path relative to the import root, or `undefined` when the entry is
   * outside it. Absolute names, names that climb out with `..`, and names
   * outside the archive's own top-level directory are never accepted.
   */
  relative(header: TarHeader): string | undefined {
    if (header.path.startsWith("/")) return undefined;
    const path = normalizePath(header.path);
    if (path === undefined || path === "") return undefined;
    this.#root ??= firstSegment(path);
    if (!path.startsWith(`${this.#root}/`)) return undefined;
    const inRepo = path.slice(this.#root.length + 1);
    if (!inRepo.startsWith(this.#prefix)) return undefined;
    return inRepo.slice(this.#prefix.length) || undefined;
  }

  accept(header: TarHeader): boolean {
    if (this.relative(header) === undefined) return false;
    const { limits, source } = this.context;
    if (this.files.length >= limits.maxFiles) {
      throw new GitHubImportError(
        "too-many-files",
        `${source.owner}/${source.repo} has more than ${limits.maxFiles} files. Try importing a subfolder.`,
      );
    }
    this.#bytes += header.size;
    if (this.#bytes > limits.maxTotalBytes) throw tooLarge(source, limits.maxTotalBytes);
    return true;
  }

  add(entry: TarHeader & { readonly bytes?: Uint8Array }): void {
    const path = this.relative(entry);
    if (path === undefined || entry.type === "directory") return;
    if (!entry.bytes) {
      this.skipped += 1;
      return;
    }
    this.files.push({ path, bytes: entry.bytes, mode: (entry.mode & 0o111) === 0 ? 0o644 : 0o755 });
  }
}

/** Passes bytes through, failing the stream with `makeError()` once more than `limit` bytes went by. */
function byteLimit(
  limit: number,
  makeError: () => Error,
  onTotal: (total: number) => void = noProgress,
): TransformStream<Uint8Array, Uint8Array> {
  let total = 0;
  return new TransformStream({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > limit) {
        controller.error(makeError());
        return;
      }
      onTotal(total);
      controller.enqueue(chunk);
    },
  });
}
