// What the importer shows when something goes wrong, and how sizes and waits read.
import { GitHubImportError } from "./github/errors";
import { COPY, fill } from "./copy";

/** "45 seconds", "1 minute", "3 minutes": a wait, rounded up to whole minutes past a minute. */
export function formatWait(seconds: number): string {
  if (seconds < 60) return fill(COPY.placeholder.seconds, { count: Math.max(1, Math.ceil(seconds)) });
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? COPY.placeholder.minute : fill(COPY.placeholder.minutes, { count: minutes });
}

/** Bytes as KiB or MiB with one decimal, the way the import limits are written. */
export function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** The sentence to show for a failed import. */
export function importErrorMessage(error: unknown): string {
  if (!(error instanceof GitHubImportError)) return storageOrGeneric(error);
  switch (error.code) {
    case "not-found":
    case "invalid-source":
      return COPY.errors.repoNotFound;
    case "private":
      return COPY.errors.privateRepo;
    case "too-large":
      return COPY.errors.repoTooLarge;
    case "too-many-files":
      return COPY.errors.repoTooManyFiles;
    case "subdir-not-found":
      return COPY.errors.subdirNotFound;
    case "rate-limited":
      return error.retryAfter
        ? fill(COPY.errors.githubRateLimit, { retryAfter: formatWait(error.retryAfter) })
        : COPY.errors.githubRateLimitUnknown;
    case "network":
      return COPY.placeholder.networkError;
    default:
      return fill(COPY.placeholder.importFailed, { message: error.message });
  }
}

function storageOrGeneric(error: unknown): string {
  if (isStorageFull(error)) return COPY.errors.storageFull;
  const message = error instanceof Error ? error.message : String(error);
  return fill(COPY.placeholder.importFailed, { message });
}

/** WASI's ENOSPC, which Waffle's filesystem returns for a full disk. */
const ENOSPC = 51;

/**
 * Whether the browser ran out of storage. Waffle reports it several ways: a DOMException named
 * `QuotaExceededError`, a worker error that copies that name or the code `ENOSPC` onto a plain
 * Error ("Filesystem worker failed: QuotaExceededError"), or a FilesystemError with errno 51.
 * The cause chain is followed, since wrappers keep the original as `cause`.
 */
export function isStorageFull(error: unknown, depth = 0): boolean {
  if (typeof error !== "object" || error === null || depth > 4) return false;
  const { name, code, errno, message, cause } = error as Record<string, unknown>;
  if (name === "QuotaExceededError" || code === "ENOSPC" || errno === ENOSPC) return true;
  if (typeof message === "string" && /QuotaExceededError|ENOSPC/.test(message)) return true;
  return isStorageFull(cause, depth + 1);
}
