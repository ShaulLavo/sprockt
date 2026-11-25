// Workbench and terminal strings. Entries under `ui` are verbatim from the copywriter's ui.json;
// entries under `pending` are short functional placeholders waiting for real copy.

export const ui = {
  panels: {
    explorer: "Explorer",
    files: "Files",
    code: "Code",
    preview: "Preview",
    terminal: "Terminal",
  },
  empty: {
    noTerminal: "No terminal open. Start a new shell to run commands.",
  },
  errors: {
    bootFailed: "This workspace could not start: {message}",
    saveFailed: "Could not save changes to browser storage.",
  },
  tabs: {
    liveBadge: "{count} tabs",
    liveBadgeTooltip: "This workspace is open in {count} browser tabs. Changes sync live.",
  },
  boot: {
    openingStorage: "Opening workspace storage",
    startingRuntime: "Starting runtime",
    ready: "Ready",
  },
  search: {
    commandPalette: "Search files and commands",
    quickOpen: "Open file by name",
  },
  status: {
    saved: "Saved",
    saving: "Saving",
    saveFailed: "Save failed",
  },
} as const;

export const pending = {
  home: "Sprockt home",
  workspace: "Workspace",
  busy: "This workspace is open in another tab.",
  openHere: "Open it here",
  views: "Views",
  panes: "Panes",
  menu: "Menu",
  theme: "Theme",
  themeSystem: "Match system",
  themeLight: "Light",
  themeDark: "Dark",
  resizeExplorer: "Resize explorer",
  resizePreview: "Resize preview",
  resizeTerminal: "Resize terminal",
  moved: "This workspace moved to another tab.",
  movedShort: "Open in another tab",
} as const;
