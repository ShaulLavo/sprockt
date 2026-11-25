# FileService contract

`src/files/service.ts` is the only door to a workspace's files. Paths are project-relative
(`src/main.ts`; the root is `""`). The members below were added to the foundation's; nothing that
existed before changed meaning.

| Member                     | What it is for                                                                                                                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `readdir(path)`            | One directory level, folders first, with empty directories and `node_modules` / `.git`; `undefined` when it is missing or a file. Lazy trees use this.                                                                                                  |
| `create(path, content?)`   | Creates a file that does not exist. Throws `DestinationExistsError` instead of replacing anything, even when the name was taken a moment ago by the shell or another tab.                                                                               |
| `move(from, to)`           | Rename or move. Throws `DestinationExistsError` when the destination exists and `MoveIntoItselfError` for a destination inside the source, both before anything is changed. Waffle has no no-replace rename, so the check is made just before the move. |
| `upload(items, directory)` | Files and folders from outside, replacing files with the same path. Names must be plain relative paths: absolute names and empty, `.` or `..` segments are skipped, as is anything inside `node_modules` or `.git`.                                     |
| `exportZip()`              | The whole project as a ZIP `Blob` (the writer in `src/lib/zip`), without `node_modules` and `.git`.                                                                                                                                                     |
| `subscribe(listener)`      | Like `revision` but says what changed (below).                                                                                                                                                                                                          |

## `subscribe` events

`{ paths, reset, moves, removed }`, delivered after changes are coalesced over 50 ms.

- `paths`: created, changed or removed project paths, from this service and from the watcher
  (the shell, Bun, another tab).
- `reset`: events may have been lost (watcher overflow or reopen). Treat everything as changed.
- `moves`: made through `move`. **A folder move lists the folder and every file inside it**, each
  with its old and new path, so a buffer or draft for any descendant can follow its file.
- `removed`: made through `remove`. **Deleting a folder lists the folder and every file that was
  inside it**, so no open buffer stays attached to a path that no longer exists. Deletions made by
  the shell or another tab are not listed here; they arrive in `paths`.

Descendants are listed before the move or delete runs, so the lists hold files only (an empty
folder has nothing to follow).

## Rules every operation follows

- Every path is checked by the foundation's resolver (Waffle resolves it, the result must be inside
  `/workspace`) right before it is used, with a fresh check per file; upload reads a file's bytes
  first and checks afterwards, so the check describes the filesystem as the write finds it.
- Waffle returns a failed change to its caller and keeps the same error to throw again at the
  next flush. A flush that throws exactly an error one of our operations already reported to its
  caller (a refused `create` or `move`) is tried again; any other error, including one that cannot
  be matched to an operation, fails the save state. Waffle should report a failure once
  (ARCHITECTURE.md, Known gaps 5).
- Two windows remain until Waffle has a no-replace rename and operations bound to a root: a name
  taken between `move`'s last look and the rename is replaced, and a link changed between the
  boundary check and the operation can lead elsewhere (Known gaps 5).

## Watcher

`watch.ts` reopens itself with a growing pause when Waffle ends or fails the watch. An overflow
ends that watch (Waffle treats it as terminal): everything is reported as changed and a new watch
is opened; repeated overflows keep backing off. Churn inside `node_modules` and `.git` is ignored;
the directory entries themselves are not.
