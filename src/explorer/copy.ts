// Explorer strings, synced with copy/ui.json.
import type { NameProblem } from "../files/paths";

export const copy = {
  title: "Explorer",
  empty: "No files yet.",
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
  confirmMany: {
    title: "Delete {count} items?",
    body: "This removes the selected items and their contents from your browser workspace. This cannot be undone.",
    confirm: "Delete items",
    cancel: "Cancel",
  },
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
  unsaved: "Unsaved changes",
  problems: {
    empty: "Enter a name.",
    separator: "Names cannot include slashes or backslashes.",
    reserved: "The names . and .. are reserved.",
    "too-long": "Names must be 255 bytes or fewer.",
    exists: "A file or folder with this name already exists here.",
  } satisfies Record<NameProblem, string>,
  notices: {
    moveExists: "{name} already exists in that folder.",
    folderGone: "The folder for {path} was moved or deleted.",
    failed: "File operation failed: {message}",
    skippedOne: "Skipped 1 item.",
    skipped: "Skipped {count} items.",
    zipFailed: "Could not create ZIP: {message}",
  },
} as const;

export function fill(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => String(values[key] ?? match));
}
