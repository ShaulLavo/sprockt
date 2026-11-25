// Workbench strings, synced with copy/ui.json.
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
    busy: "This workspace is open in another tab. Opening it here disconnects the other tab.",
    moved: "Another tab took over this workspace. Open it here to keep working.",
    movedShort: "Open in another tab",
    openHere: "Open here",
    liveBadge: "{count} tabs",
    liveBadgeTooltip: "This workspace is open in {count} browser tabs.",
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
  workbench: {
    home: "Go to Sprockt home",
    workspace: "Workspace",
    views: "Panels",
    panes: "Workspace panes",
    menu: "Workspace menu",
    theme: "Theme",
    themeLight: "Use light theme",
    themeDark: "Use dark theme",
    resizeExplorer: "Resize explorer",
    resizePreview: "Resize preview",
    resizeTerminal: "Resize terminal",
  },
} as const;
