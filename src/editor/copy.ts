// Editor strings. The first group is copied from the copywriter's ui.json; the second group are
// functional placeholders the copywriter has not written yet (listed in the slice 3 report).
export const EDITOR_COPY = {
  editor: "Editor",
  noOpenEditor: "No file open. Pick a file from the tree or use quick open.",
  externalChangeConflict: "This file changed in another tab or process. Reload from disk or keep your edits.",

  // Placeholders.
  openFiles: "Open files",
  reloadFromDisk: "Reload from disk",
  keepMine: "Keep my edits",
  unsavedChanges: "Unsaved changes",
  closeTab: "Close {name}",
  discardChanges: "{name} has unsaved changes. Close it and discard them?",
  deletedFile: "Deleted from disk",
} as const;

export { fill } from "../search/copy";
