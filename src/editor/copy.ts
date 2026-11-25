// Editor strings, synced with copy/ui.json.
export const EDITOR_COPY = {
  editor: "Editor",
  noOpenEditor: "No file open. Pick a file from the tree or use quick open.",
  externalChangeConflict: "This file changed on disk. Reload it or keep your edits.",
  openFiles: "Open files",
  reloadFromDisk: "Reload from disk",
  keepMine: "Keep my edits",
  unsavedChanges: "Unsaved changes",
  closeTab: "Close {name}",
  discardChanges: "{name} has unsaved changes. Close without saving?",
  deletedFile: "Deleted from disk",
} as const;

export { fill } from "../search/copy";
