# Explorer file tree

Workspace file tree (`src/explorer/`) backed by Waffle's persistent FileService with real-time watcher sync.

## Sub-features

- Expand/collapse folders, indent guides, file-type icons, and single/multi-select with keyboard navigation.
- Inline filter box (`tree-filter-input`) showing matching files plus context-only ancestor folders.
- Create file (`new-file`), create folder (`new-folder`), rename (`F2`), drag-and-drop move, delete with confirmation (`wb-confirm-dialog`), upload files/folders, and ZIP download (`download-zip`).
- Context menu (`[data-wb-point-context-menu]`) and dirty/unsaved protection before destructive operations.

## How to get to it (user POV)

On desktop, the Explorer sits in the left sidebar (`file-tree`). On phone (`<= 768px`), tap **Files** in the bottom `pane-switcher`. Click any file row to open it in the editor; focus the tree and press `Mod+F` (or start typing) to open the inline filter box (`tree-filter-input`); use the toolbar icons or right-click menu for CRUD actions.

## Driving it with agent:browser

```bash
bun run agent:browser scenario workbench-tabs-and-explorer
```

The scenario filters `file-tree` for `App.css`, opens it, clears the filter, creates `notes.txt` via `new-file` + `tree-input`, and verifies the new file opens in the editor.

## Gotchas

- Context-only ancestor folders shown while filtering must never be included in Select All or bulk Delete (deleting a filtered match must not wipe hidden siblings).
- Pressing `F2` to rename a file inside a collapsed ancestor while filtering expands its ancestors before mounting the rename input.
- Playwright WebKit `setInputFiles(directory)` hangs; directory upload tests use the in-page picker path (`e2e/files.spec.ts`).
