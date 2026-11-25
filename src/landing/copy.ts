// Functional placeholders the copywriter has not written yet (labels for assistive technology
// and the phone menu). Listed in the copy requests for the identity pass.
export const PENDING_COPY = {
  skip: "Skip to content",
  menu: "Menu",
  browsers: "Browsers",
  heroFrame: "Sprockt in a browser tab, running the Vite + React starter",
  benchFrame: "The Sprockt workbench: files, editor, preview and terminal",
} as const;

// Copy strings synced with /work/reports/sprockt-v1-20261125/copy/landing.json.
export const LANDING_COPY = {
  navTemplates: "Templates",
  navWhy: "Why Sprockt",
  navDocs: "Docs",
  navGithub: "GitHub",
  navCta: "New workspace",
  heroPill: "Bun 1.4.4 in WebAssembly",
  heroTitle: "Real Bun in any browser tab.",
  heroLede:
    "Open a public GitHub repo or a starter template. Sprockt installs packages and runs your app in Chrome, Firefox, Safari and iPhone Safari.",
  heroCta: "Start Vite + React",
  heroSecondary: "Browse templates",
  consoleTitle: "New workspace",
  openLabel: "GitHub repository",
  openPlaceholder: "owner/repo",
  openButton: "Open repo",
  openError: "Enter owner/repo or a github.com URL.",
  openTry: "Try",
  altBlank: "New blank workspace",
  altBlankShort: "Blank workspace",
  templatesTitle: "Start from a template",
  templatesNote: "Installs packages and runs with Bun.",
  templateAction: "Create",
  templateCreating: "Creating...",
  recentTitle: "Recent workspaces",
  recentNote: "Stored in this browser",
  recentOpenElsewhere: "Active in another tab",
  recentStorage: "Saved in this browser. Nothing is uploaded.",
  recentEmpty: "No saved workspaces yet. Pick a template or open a GitHub repo to create one.",
  recentRename: "Rename workspace",
  recentDelete: "Delete workspace",
  recentMore: "Workspace actions",
  recentSave: "Save",
  recentCancel: "Cancel",
  recentConfirmDelete: "Delete",
  recentBusyDelete: "Close this workspace in other tabs before deleting it.",
  recentBusyRename: "Close this workspace in other tabs before renaming it.",
  recentBusyRetry: "Close this workspace in other tabs before retrying setup.",
  recentIncompleteSeeding: "Setup did not finish",
  recentIncompleteImporting: "Import did not finish",
  recentRetry: "Retry",
  recentRetrying: "Retrying...",
  whyTitle: "Why Sprockt",
  whyNote: "Open a tab and start coding. No account needed.",
  whyBrowsersTitle: "Any browser, including iPhone",
  whyBrowsersBody:
    "Runs in Chrome, Firefox, desktop Safari and iPhone Safari. No extension or Chromium lock-in.",
  whyBunTitle: "Real Bun in WebAssembly",
  whyTabsTitle: "One workspace across tabs",
  whyTabsBody:
    "Projects stay saved in IndexedDB. A second tab attaches to the same live files and dev server.",
  whyOssTitle: "Free and MIT open source",
  whyOssBody:
    "Sprockt, its Bun runtime, browser OS, editor, GPU terminal and shell are all MIT licensed on GitHub.",
  footerLine:
    "MIT licensed. Built on bun-wasm, Waffle, Singapore, ghostty-webgpu and bash-web. Product names and logos belong to their owners.",
} as const;
