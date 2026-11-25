// Terminal strings. `ui` entries are verbatim from the copywriter's ui.json; `pending` entries are
// short functional placeholders waiting for real copy.

export const ui = {
  terminal: "Terminal",
  noTerminal: "No terminal open. Start a new shell to run commands.",
} as const;

export const pending = {
  tabs: "Terminal tabs",
  newTerminal: "New terminal",
  splitTerminal: "Split terminal",
  unsplitTerminal: "Join terminals",
  killTerminal: "Kill terminal",
  closeTerminal: "Close {name}",
  renameTerminal: "Rename {name}",
  collapsePanel: "Collapse panel",
  expandPanel: "Expand panel",
  terminalKeys: "Terminal keys",
  shellStopped: "The shell stopped unexpectedly.",
} as const;
