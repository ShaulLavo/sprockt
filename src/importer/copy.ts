// User-facing strings for the importer and share links. The `errors` entries are copied word for
// word from the copy deck (copy/ui.json). The `placeholder` entries are short functional text
// waiting for the copywriter; keep them listed in the slice report until they are replaced.
export const COPY = {
  errors: {
    repoNotFound: "Repository not found. Check the owner, name and branch, then try again.",
    privateRepo: "Private repositories are not supported. Sprockt can only import public GitHub repos.",
    repoTooLarge:
      "This repository exceeds the import limit of 100 MiB compressed or 256 MiB unpacked. Try importing a subfolder.",
    repoTooManyFiles: "This repository has more than 20,000 files. Try importing a subfolder.",
    subdirNotFound: "Subfolder not found in this repository.",
    githubRateLimit: "GitHub rate limit reached. Try again in {retryAfter}.",
    githubRateLimitUnknown: "GitHub rate limit reached. Wait a few minutes and try again.",
    shareLinkTooBig: "This workspace is too large for a share link. Download it as a ZIP instead.",
    shareLinkInvalid: "This share link is damaged or incomplete.",
    storageFull: "Browser storage is full. Delete an unused workspace or clear site data to free space.",
  },
  confirm: {
    discardTitle: "Discard workspace {name}?",
    discardBody: "This permanently deletes all files in this workspace from your browser storage.",
    discardConfirm: "Discard workspace",
    cancel: "Cancel",
  },
  placeholder: {
    importIncomplete: "Import didn't finish",
    delete: "Delete",
    deleteBusy: "This workspace is open in another tab. Close it there, then try again.",
    importing: "Importing {name}",
    resolving: "Finding the repository",
    downloading: "Downloading {size}",
    writing: "Writing {count} files",
    opening: "Opening the workspace",
    openingShare: "Opening the shared project",
    sharedName: "Shared project",
    importFailed: "The import did not finish: {message}",
    networkError: "Could not reach GitHub. Check your connection and try again.",
    tryAgain: "Try again",
    backHome: "Back to Sprockt",
    share: "Share",
    shareCopied: "Link copied",
    shareReady: "Share link",
    shareFailed: "Could not make a share link: {message}",
    seconds: "{count} seconds",
    minute: "1 minute",
    minutes: "{count} minutes",
  },
} as const;

/** Fills `{name}` slots in a copy string. */
export function fill(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (slot, key: string) => String(values[key] ?? slot));
}
