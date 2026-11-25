export type GitHubErrorCode =
  | "invalid-source"
  | "not-found"
  | "private"
  | "rate-limited"
  | "too-large"
  | "too-many-files"
  | "subdir-not-found"
  | "bad-archive"
  | "network"
  | "upstream";

/** A failure the UI can show as is: `message` is written for the person importing. */
export class GitHubImportError extends Error {
  constructor(
    readonly code: GitHubErrorCode,
    message: string,
    /** Seconds until a rate limit resets, when GitHub said. */
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "GitHubImportError";
  }
}

/** The JSON body the proxy sends with every error response. */
export interface ProxyErrorBody {
  readonly error: GitHubErrorCode;
  readonly message: string;
  readonly retryAfter?: number;
}

/** Repository metadata the proxy returns from `GET <base>/repo/<owner>/<repo>`. */
export interface RepoInfo {
  readonly owner: string;
  readonly repo: string;
  readonly defaultBranch: string;
  /** GitHub's size estimate of the repository in KiB; archives are usually smaller. */
  readonly sizeKiB: number;
}
