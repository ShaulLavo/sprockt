// User-facing strings for the importer and share links, synced with copy/ui.json.
const ERRORS = {
  repoNotFound: "Repository not found. Check the owner, name and branch, then try again.",
  privateRepo: "Private repositories are not supported. Sprockt can only import public GitHub repos.",
  repoTooLarge:
    "This repository exceeds the import limit of 100 MiB compressed or 256 MiB unpacked. Try importing a subfolder.",
  repoTooManyFiles: "This repository has more than 20,000 files. Try importing a subfolder.",
  subdirNotFound: "Subfolder not found in this repository.",
  githubRateLimit: "GitHub rate limit reached. Try again in {retryAfter}.",
  githubRateLimitUnknown: "GitHub rate limit reached. Wait a few minutes and try again.",
  importFailed: "Import failed: {message}",
  networkError: "Could not reach GitHub. Check your connection and try again.",
  shareLinkTooBig: "This workspace is too large for a share link. Download it as a ZIP instead.",
  shareLinkInvalid: "This share link is damaged or incomplete.",
  shareFailed: "Could not create share link: {message}",
  deleteBusy: "Close this workspace in other tabs before deleting it.",
  deleteFailed: "Could not delete this workspace. Try again.",
  storageFull: "Browser storage is full. Delete an unused workspace or clear site data to free space.",
} as const;

const IMPORTER = {
  importIncomplete: "Import did not finish",
  delete: "Delete",
  importing: "Importing {name}",
  resolving: "Finding repository",
  downloading: "Downloading {size}",
  writingOne: "Writing 1 file",
  writing: "Writing {count} files",
  opening: "Opening workspace",
  tryAgain: "Try again",
  backHome: "Back to Sprockt",
  second: "1 second",
  seconds: "{count} seconds",
  minute: "1 minute",
  minutes: "{count} minutes",
} as const;

const SHARE = {
  share: "Share",
  shareCopied: "Link copied",
  shareReady: "Share link",
  openingShare: "Opening shared workspace",
  sharedName: "Shared workspace",
} as const;

export const COPY = {
  errors: ERRORS,
  confirm: {
    discardTitle: "Discard workspace {name}?",
    discardBody: "This permanently deletes all files in this workspace from your browser storage.",
    discardConfirm: "Discard workspace",
    cancel: "Cancel",
  },
  importer: IMPORTER,
  share: SHARE,
} as const;

/** Fills `{name}` slots in a copy string. */
export function fill(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (slot, key: string) => String(values[key] ?? slot));
}
