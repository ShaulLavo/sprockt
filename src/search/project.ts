// Project-wide search over FileService. Files are read and matched a batch at a time and results
// stream out per file in path order, so the panel fills while it runs, memory stays bounded by
// one batch, and a new query aborts the old one. Matching goes through a `FileMatcher`: the panel
// runs it in a worker it can terminate, so a regular expression that backtracks for ever never
// freezes the page. node_modules and .git never enter: FileService.list skips them.
import type { FileService } from "../files/service";
import { compileGlobs } from "./glob";
import { compileQuery, matchBytes, type LineMatch, type SearchQuery } from "./text";

export interface FileMatches {
  readonly path: string;
  readonly matches: readonly LineMatch[];
}

/** Finds up to `limit` matches in one file's bytes; none for a binary file. Rejects when aborted. */
export type FileMatcher = (bytes: Uint8Array, query: SearchQuery, limit: number) => Promise<LineMatch[]>;

/** Matches on the calling thread. For tests and small inputs; the panel uses a worker. */
export const matchInPage: FileMatcher = async (bytes, query, limit) => matchBytes(bytes, query, limit);

export interface ProjectSearchRequest {
  readonly query: SearchQuery;
  /** Comma-separated globs; empty means every file. */
  readonly include: string;
  readonly exclude: string;
  readonly signal: AbortSignal;
  readonly onFile: (result: FileMatches) => void;
  /** Defaults to matching in the page. */
  readonly match?: FileMatcher;
}

export type ProjectSearchSummary =
  | { readonly kind: "done"; readonly files: number; readonly matches: number; readonly truncated: boolean }
  | { readonly kind: "invalid"; readonly message: string }
  /** Matching broke down (the worker failed); the results so far stay. */
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "aborted" };

/** Results stop here: past this the panel is not useful and the page only gets slower. */
export const MAX_MATCHES = 5000;
/** Files read and matched at once. Also the most files whose results are held before delivery. */
export const BATCH_SIZE = 16;
/** Bigger files are almost always generated or minified. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

type Files = Pick<FileService, "list" | "readBytes" | "size">;

export async function searchProject(
  files: Files,
  request: ProjectSearchRequest,
): Promise<ProjectSearchSummary> {
  const compiled = compileQuery(request.query);
  if (typeof compiled === "string") return { kind: "invalid", message: compiled };
  const match = request.match ?? matchInPage;
  const include = compileGlobs(request.include);
  const exclude = compileGlobs(request.exclude);
  const paths = (await files.list()).filter((path) => (!include || include(path)) && !exclude?.(path)).sort();
  let total = 0;
  let filesWithMatches = 0;

  async function searchOne(path: string, limit: number): Promise<FileMatches | null> {
    // A file that cannot be read is skipped; a matcher that fails ends the whole search.
    // A known size over the limit skips the file unread. An unknown size (the lookup failed or
    // could not tell) never drops a file: it is read and the byte count decides.
    const size = await files.size(path).catch(() => undefined);
    if (size !== undefined && size > MAX_FILE_BYTES) return null;
    const bytes = await files.readBytes(path).catch(() => undefined);
    if (!bytes || bytes.length > MAX_FILE_BYTES || request.signal.aborted) return null;
    const matches = await match(bytes, request.query, limit);
    return matches.length > 0 ? { path, matches } : null;
  }

  function deliver(results: readonly (FileMatches | null)[]): void {
    for (const result of results) {
      if (!result || total >= MAX_MATCHES) continue;
      const kept = result.matches.slice(0, MAX_MATCHES - total);
      total += kept.length;
      filesWithMatches += 1;
      request.onFile({ path: result.path, matches: kept });
    }
  }

  async function runBatches(): Promise<void> {
    for (let start = 0; start < paths.length && total < MAX_MATCHES; start += BATCH_SIZE) {
      const limit = MAX_MATCHES - total;
      const batch = paths.slice(start, start + BATCH_SIZE);
      // Batches run one after another so that results are held for one batch at most.
      // oxlint-disable-next-line no-await-in-loop
      const results = await Promise.all(batch.map((path) => searchOne(path, limit)));
      if (request.signal.aborted) return;
      deliver(results);
    }
  }

  try {
    await runBatches();
  } catch (error) {
    if (request.signal.aborted) return { kind: "aborted" };
    return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
  }
  if (request.signal.aborted) return { kind: "aborted" };
  return { kind: "done", files: filesWithMatches, matches: total, truncated: total >= MAX_MATCHES };
}
