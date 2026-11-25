// User-facing strings of the explorer. Entries marked "ui.json" are verbatim from the copywriter's
// `copy/ui.json`; the rest are functional placeholders the copywriter replaces (see the PR).
import type { NameProblem } from "../files/paths";

export const copy = {
  /** ui.json panels.explorer */
  title: "Explorer",
  /** The final string main shipped for the explorer's empty state (PR 13). */
  empty: "No files yet.",
  /** ui.json confirm.deleteFile and confirm.deleteFolder */
  confirmFile: {
    title: "Delete {name}?",
    body: "This removes the file from your browser workspace and cannot be undone.",
    confirm: "Delete file",
    cancel: "Cancel",
  },
  confirmFolder: {
    title: "Delete {name}?",
    body: "This removes the folder and everything inside it from your browser workspace. This cannot be undone.",
    confirm: "Delete folder",
    cancel: "Cancel",
  },
  // Placeholders: a delete of several items has no copy yet.
  confirmMany: {
    title: "Delete {count} items?",
    body: "This removes the selected files and folders, and everything inside the folders, from your browser workspace. This cannot be undone.",
    confirm: "Delete items",
    cancel: "Cancel",
  },
  // Placeholders: the mock's action labels, menu items and messages.
  actions: {
    newFile: "New file",
    newFolder: "New folder",
    uploadFiles: "Upload files",
    uploadFolder: "Upload folder",
    download: "Download as ZIP",
    collapseAll: "Collapse all",
    rename: "Rename",
    delete: "Delete",
    more: "More actions",
    menu: "File actions",
  },
  drop: "Drop to upload",
  unsaved: "unsaved",
  problems: {
    empty: "Enter a name.",
    separator: "A name cannot contain slashes or backslashes.",
    reserved: "This name is reserved.",
    "too-long": "This name is too long.",
    exists: "A file or folder with this name already exists here.",
  } satisfies Record<NameProblem, string>,
  notices: {
    moveExists: "{name} already exists in the destination.",
    unsaved: "{name} has unsaved changes. Save them or close the file first.",
    failed: "That did not work: {message}",
    skipped: "{count} items were skipped.",
    zipFailed: "Could not create the ZIP: {message}",
  },
} as const;

export function fill(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => String(values[key] ?? match));
}
