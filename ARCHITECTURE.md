# Sprockt architecture

Status: Approved. Milestone 1 (this foundation) is built; the slices at the end build the rest.

Sprockt is a browser IDE served at `sprockt.dev`. Everything runs in the visitor's tab: a
[Waffle](https://github.com/ShaulLavo/waffle) kernel (filesystem, processes, pipes, loopback
network), [bun-wasm](https://github.com/ShaulLavo/bun-wasm) as the JavaScript runtime and package
manager, [bash-web](https://github.com/ShaulLavo/bash-web) as the shell,
[Ghostty WebGPU](https://github.com/ShaulLavo/ghostty-webgpu) as the terminal and
[Singapore](https://github.com/ShaulLavo/singapore) as the editor. There is no backend.

## Decisions

| Area         | Decision                                                       | Why                                                                                                                                                             |
| ------------ | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI framework | Solid 1.9                                                      | Fine-grained updates with no virtual DOM diff keep typing, tree refreshes and terminal output off any render path. Singapore ships a first-party Solid binding. |
| Build        | Vite 8, ES module workers                                      | The tested bundling path of bun-wasm and Ghostty (`?worker&url`, `?url`).                                                                                       |
| Storage      | Waffle `mode: "fast"` on IndexedDB, one database per workspace | The persistent path is the product path; `mode: "memory"` is not used.                                                                                          |
| Tabs         | Waffle `whenBusy: "attach"`                                    | The first tab hosts the filesystem; later tabs attach and share it live. Set to `takeover` until Waffle's attach mode is fixed (Known gaps, 1).                 |
| Hosting      | Cloudflare Worker with static assets only                      | No server code is needed until previews move to their own origins.                                                                                              |
| Language     | TypeScript only, strict                                        | `bun run check:javascript` fails on any hand-written JavaScript.                                                                                                |

## Module map

```
src/
  main.tsx            entry: mounts <App>
  app/                routes (pure URL <-> Route), router (signal + history), App, debug handle
  landing/            landing page: templates, GitHub URL bar, workspace switcher
  workbench/          the IDE frame: pane layout, status bar, boot progress
  workspace/          WorkspaceSession (the state root), paths and ids
  runtime/            boot (Waffle + Bun + coreutils + shell), worker and guest URLs, guest lock
  files/              FileService (read, write, move, remove, watch, flush), tree model
  explorer/           file tree UI
  editor/             EditorPane, tabs, EditorStore, file buffers, theme, plugin mount hook
  search/             quick open (fuzzy file finder) and project search, run in the page
  terminal/           TerminalPane, Ghostty + bash-web session
  preview/            PreviewTransport seam, PreviewPane
  templates/          (slice 1) starter catalog and file sets
  importer/           (slice 4) GitHub import, install and dev-script detection, share links
  tasks/              (slice 5) dev-server detection and the cross-tab dev-server owner
e2e/                  Playwright specs; helpers.ts is the shared fixture
scripts/              fetch-guests, check-javascript
```

Rules that keep the map true:

- A pane imports from `workspace/` and from its own directory. Panes never import each other;
  they meet through services on the session.
- Logic that can be pure lives in a `.ts` file with no Solid and no DOM import, next to a
  `.test.ts` that `bun test` runs. Components stay thin.
- `runtime/` knows nothing about UI. `files/` is the only module that calls
  `runtime.filesystem` on behalf of the UI.

## State

One `WorkspaceSession` exists per open workspace per tab. `openWorkspace(id)` creates it and
`WorkspaceContext` hands it to every pane.

```
WorkspaceSession
  id          workspace id, also the URL segment
  runtime     the tab's single Waffle Runtime
  shell       wasm URL, worker URL, cwd and env every shell starts with
  files       FileService
  preview     PreviewTransport
  (slices add) editor: EditorStore, terminals: TerminalStore, tasks: DevServers
```

- **Files are the source of truth.** The Waffle filesystem holds the project at `/workspace`.
  An editor buffer is a cache; saving goes through `FileService`.
- **The project boundary is enforced at FileService.** Paths are plain project-relative names.
  An absolute path, an empty, `.` or `..` segment, or a NUL is refused with `ProjectPathError`
  before anything is written; a bulk write with one bad path writes nothing. For links, the
  service asks Waffle to resolve the path right before each operation and works nothing out
  itself: a path Waffle resolves to a place outside `/workspace` is refused, and a symbolic
  link is never the entry that is read or written, nor the directory a new entry is created
  in (a link itself can still be removed or moved). The check and the operation are two steps,
  so a link swapped in between them is not caught; closing that needs Waffle to enforce a root
  inside the operation (Known gaps, 5).
- **One change signal.** `FileService.revision` moves when project files change, whatever the
  source: a page write, the shell, Bun, or another tab. It is fed by a recursive Waffle watch
  (`FilesystemClient.watch`) and coalesced over 50 ms. The explorer re-lists on it; clean
  editor buffers reload on it (slice 3); `node_modules` and `.git` churn does not move it.
- **`saved` is a persistence guarantee.** Waffle acknowledges writes from memory.
  `files/persistence.ts` reports `saving` from the moment a write starts and `saved` only once
  a flush that started after the last change has finished. Every change counts, including the
  shell's and Bun's and those inside `node_modules`. A failed flush is `failed`.
  `FileService.saved()` resolves when every change acknowledged before the call is flushed,
  however many follow: a caller waits for its own write, not for the workspace to go quiet.
- **The editor saves what it shows.** `editor/buffers.ts` keeps one Singapore text buffer per
  open tab, with its own undo history, carets and scroll; switching tabs attaches another
  buffer to the one editor. A save writes a buffer's own text under its own path (the file on
  screen, never the one merely selected while it loads). Saves of one path run in order, even
  across closing and reopening the file. "Unsaved" means the text differs from what is on disk
  or from what a pending save is writing, so a buffer is clean only once its write succeeded.
  Unsaved text stays with its tab until it is saved or the person confirms closing it.
- **Text is recoverable until storage holds it.** A save acknowledged from memory is not
  durable yet. The editor keeps such text recoverable until the flush that covers it is done
  (`FileService.saved()`), together with what storage held before it, even after its tab
  closes. A copy another tab left for a file is removed only after that file's text is durable,
  or the person reloads from disk or closes the tab.
- **A save never overwrites a change it has not seen.** On every `revision` a clean buffer
  reloads the file as one undoable edit; a buffer with unsaved edits gets a conflict at once.
  Saves use `writeIfUnchanged(path, text, textLastInStepWith)`, which also catches a change
  made between the last reload and the save. The person chooses: reload from disk, or keep
  the edits (which saves them); both read the file again first. The check and the write are two
  steps; making them one needs a conditional write in Waffle.
- **Stores are factories, not globals.** `createEditorStore()`, `createFileService(runtime)`:
  each returns accessors and methods. The router is the only module-level signal.
- **Workspaces are discovered, not indexed.** The landing page lists
  `storedWorkspaces("fast")` filtered by the `sprockt-` prefix. Names and metadata (template,
  last opened) live in `/.sprockt/workspace.json` in the workspace's filesystem, outside the
  project root, so a project cannot overwrite them and they are not exported with it. Only a
  `WorkspaceMetadata` API in `workspace/` (slice 1) reads and writes that file; FileService
  cannot reach it.

## Workspace lifetime

Waffle allows one live runtime per page. `workspace/lifecycle.ts` is the turnstile that
guarantees it. The workbench opens a workspace through it and closes it on the way out:

- A workspace starts only after the previous one is fully torn down.
- Closing a workspace aborts its boot, also while it waits for storage another tab holds, and
  disposes its runtime.
- Teardown runs every step (file service, preview transport, runtime) even if one fails.

An ordinary open never takes a workspace from another tab. It asks Waffle for storage with
`whenBusy: "wait"`, which queues behind the tab that has it, and the workbench then says the
workspace is open elsewhere. Only when the person chooses "Open it here" is the workspace
opened again with `whenBusy: "takeover"`. Two tabs opening the same workspace at the same
moment therefore end with one owner and one tab that asks. A quick check before anything is
started (`workspaceIsOpenElsewhere`) only decides what is shown first.

When a tab loses its workspace, its FileService refuses every write, the editor becomes
read-only and the status shows `failed`. Every text storage does not hold yet (unsaved edits,
and saves whose flush never finished) is left in `localStorage` (`editor/recovery.ts`), one key
per file, for the tab that now owns the workspace. There it shows up as an unsaved edit when
the file is opened, and it stays stored until that tab has saved and flushed it, or the person
takes the version on disk: opening the file, or reloading, does not use it up.

## Runtime boot

`runtime/boot.ts`, in order:

1. `createRuntime({ filesystem: { mode: "fast", name: "sprockt-<id>", workerURL, whenBusy }, memoryGroups })`, with `whenBusy` `"wait"`, or `"takeover"` once the person confirmed it.
   The memory group limits are bun-wasm's (2 GiB per group, 1 GiB per member, 8 MiB stacks).
2. `installBunSharedObjects`, then `installBunAdapters` with the browser engine and the pinned
   guest descriptor (URL, SHA-256, size). The guest is fetched and compiled on first `bun` use.
3. `installBase` (coreutils, findutils, grep, sed, ripgrep) on the program worker.
4. `installShellCommands` (`/bin/sh`, `/bin/bash`), sharing the shell guest with terminals.
5. Flush, then report `ready`. Terminals then start `BrowserSession`s on the same runtime.

Workers are bundled from the installed packages' sources with the app's own Waffle, so every
realm runs one Waffle version: `bun-wasm/worker`, `bun-wasm/notification-worker`,
`waffle/browser/fs-worker`, bash-web's `src/runtime/worker.ts`, and bun-wasm's
`web/src/preview1-worker.ts` as the program worker. The last two are not package exports and
are imported by path. The program worker must be bun-wasm's: it gives programs started from a
terminal their terminal, and a plain `preview1Executor` worker fails in WebKit on the second
program it runs.

## Packages and guests

| Package                                                 | Pin                | Source                                                                |
| ------------------------------------------------------- | ------------------ | --------------------------------------------------------------------- |
| `waffle` (`@waffle-os/runtime`), `@waffle-os/relay`     | 0.0.148            | npm                                                                   |
| `waffle-base`                                           | programs-v0.0.23   | GitHub release tarball                                                |
| `bash-web`                                              | 0.0.114            | npm                                                                   |
| `bun-wasm`                                              | commit `7b25271e3` | Git dependency (not on npm); `trustedDependencies` runs its `prepare` |
| `ghostty-webgpu`                                        | 0.3.34             | npm                                                                   |
| `@singapore-editor/core`, `/solid`, `/find`, `/gutters` | 0.2.13             | npm                                                                   |
| `@singapore-editor/highlighting`                        | 0.2.16             | npm (Tree-sitter grammars load per language, on first use)            |

Guests are the WASM programs the workers run. They are published to the hash-addressed guest
store, `bun-artifacts.shaulavo.dev/<sha256>/<file>.gz`, served gzip-encoded with immutable
caching and `Access-Control-Allow-Origin: *`. The packages do not name them yet: bun-wasm's
`BUN_WASM_ASSET` is `null` and the bash-web package ships no `shell-engine.wasm` (Known gaps, 3).

- `guests.lock.json` pins `bun-browser.wasm` (bun-wasm `7b25271e3`) and `shell-engine.wasm`
  (bash-web 0.0.114) by store URL, SHA-256 and size. The URL contains the hash, so it never
  serves anything else.
- `bun run guests` downloads, decodes the gzip encoding, checks the decoded size and SHA-256,
  and stages them at `public/guests/<sha256>/<name>` (written beside the target and renamed,
  so a killed run leaves no partial file). The build script runs it first, so a build never
  packages a missing or unverified guest.
- Sprockt still serves the guests from its own origin, on content-addressed, immutable URLs:
  `Cross-Origin-Embedder-Policy: require-corp` and the same-origin `Cross-Origin-Resource-Policy`
  on our pages are simplest with every asset on one origin, and Safari has no `credentialless`.
- `SPROCKT_GUEST_CACHE` (CI: an Actions cache keyed on the lock) keeps verified copies. Moving
  a pin means moving the lock entry and its package together.
- JSC and QuickJS engine guests, `bun-tools.wasm` (lint, fmt) and Python or Git programs are not
  pinned yet; add them to the lock when a slice needs them.

## Seams for the sibling lanes

**Preview** (`preview/transport.ts`). The pane asks a `PreviewTransport` for everything:
`servers()`, `subscribe()`, `frameUrl(port, path)`, `tabUrl(port, path)`, `onReloadNeeded()`.
A transport belongs to one workspace, and the workspace id is part of every route it builds:
two workspaces that both run a server on port 5173 never see each other's HTTP or WebSocket
traffic. Milestone 1 ships an inactive transport. There are two real ones:

- `mounted` (slice 5): Waffle's `PreviewRouter` plus `waffle/browser/service-worker`, serving
  `/__preview/<workspace>/<port>/` on the IDE's own origin. The service worker asks only the
  tabs that have that workspace open. A mounted preview shares the IDE's origin, so the
  previewed code can reach the workbench and its IndexedDB. **It is a development stopgap for
  trusted, local projects only.** It is selected by a build-time setting that production
  builds do not set, and it must not serve an imported project.
- `isolated` (preview-origins lane): bun-wasm's planned `RootPreviews`, whose `url(port, path)`
  returns `https://<id>-<port>-pv.sprockt.dev/…`, where `<id>` is derived from the workspace.
  Each server gets its own origin, which is what keeps a previewed project away from the IDE.
  **Isolated origins are required before any public deploy** (see "Before public deploy").

`tabUrl` exists because an isolated preview opened directly in Safari cannot reach the IDE and
has to go through a page on our origin.

**Language servers** (`editor/plugins.ts`). `registerEditorPlugins(provider)`: a provider gets
`{ runtime, projectRoot, rootUri, signal }` and returns Singapore `EditorPlugin`s, or
`{ plugins, dispose }`, synchronously or not. The editor never waits for a provider: it opens
at once with its built-in plugins (syntax, find, gutters), and a provider's plugins are added
to the running editor (`Editor.addPlugin`) when it delivers, so the text on screen and its undo
history are untouched. A provider registered while an editor is open reaches it too, and
unregistering removes its plugins. Each provider runs inside its own boundary, so one that
throws or never answers only loses its own plugins. `signal` aborts and every `dispose` runs
when the editor closes, including for a set that arrives late.
Document ids are absolute workspace paths, so a server sees `file:///workspace/src/main.ts`.
The LSP lane adds `src/lsp/typescript.ts` (its stdio transport plus
`createLanguageServerPlugin`) and one `registerEditorPlugins` call.

## Tabs

The design is `whenBusy: "attach"`: the first tab hosts the filesystem; later tabs attach as
peers and read, write and watch the same live tree. Host loss fails over inside Waffle.

Today `runtime/boot.ts` does not use attach, because attach mode in Waffle 0.0.148 loses file
bytes for programs (Known gaps, 1). A second tab waits and asks before it takes the workspace;
the older tab then stops writing and hands over its unsaved text ("Workspace lifetime").
Everything below describes the attach design the slices build toward; choosing `"attach"` in
`createWorkspaceRuntime` and dropping the question are the only changes in this repository.

- Shared across tabs: files, and through `FileService.revision`, the explorer and clean editor
  buffers.
- Per tab: the Waffle process table. Each tab runs its own shells.
- Dev servers (slice 5 and 7): one tab owns a workspace's dev server, elected with a Web Lock
  (`sprockt:<id>:dev-server`); it announces its ports on a `BroadcastChannel`. Peers show the
  same preview URL, which the shared service worker routes to the owning tab. Port the
  election and failover from bun-wasm's `sandbox/src/dev-server-coordinator.ts`.

## Routing

| Path                                                | Page                                                                          |
| --------------------------------------------------- | ----------------------------------------------------------------------------- |
| `/`                                                 | Landing                                                                       |
| `/w/<id>`                                           | Workbench for a stored or new workspace. `<id>` is `[a-z0-9][a-z0-9-]{0,62}`. |
| `/github/<owner>/<repo>[/tree/<branch>[/<subdir>]]` | Importer (slice 4): fetch, write a new workspace, redirect to `/w/<id>`.      |
| `/s/…`                                              | Share link (slice 4).                                                         |

`app/routes.ts` parses and prints all of them and is unit tested; unknown paths and paths with
malformed percent-encoding render "not found" and never guess or throw. The workbench is a
lazy chunk, so the landing page loads none of the editor, terminal or runtime code.

In our own links a branch is one segment with its slashes encoded (`feature%2Fx`), and each
subdirectory segment is encoded on its own. A URL copied from GitHub has unencoded slashes
(`/tree/feature/x/src`), and nothing in it says where the branch ends. The importer treats
`branch/subdir` as one ref path and resolves it against the repository's refs, longest match
first; only what follows the matched ref is the subdirectory.

Share links carry the project in the URL fragment (a compressed file set, with a size cap) so
they need no storage. Server-stored snapshots for larger projects need an owner decision on
where the bytes live.

## Deploy

- `wrangler.jsonc`: assets-only Worker, `not_found_handling: "single-page-application"` (deep
  links get `index.html` on navigation only; a missing worker or guest still answers 404).
- The route is the apex `sprockt.dev` only, never a wildcard. `bun.sprockt.dev` is the bun-wasm
  playground, and `<id>-<port>-pv.sprockt.dev` belongs to the preview-origins lane's Worker.
- Sprockt sets no cookies. Anything it stores is host-only (IndexedDB, `localStorage` on
  `sprockt.dev`); nothing may use `Domain=.sprockt.dev`, so previews stay isolated from the IDE.
- `public/_headers` sends `Cross-Origin-Opener-Policy: same-origin`,
  `Cross-Origin-Embedder-Policy: require-corp` and `Cross-Origin-Resource-Policy: same-origin`
  on every path. All four target browsers need COOP plus COEP for `SharedArrayBuffer`. Safari
  has no `COEP: credentialless`, so `require-corp` is the one mode that works everywhere, and
  every asset (guests, workers, fonts) is served from our own origin.
- Safari re-checks the headers when it revalidates a worker script: a `304` without them stops
  the worker from starting. The dev and preview servers set them in a Vite plugin for that
  reason. After the first deploy, check that Cloudflare's `304` responses carry them too.
- Hashed files (`/assets/*`, `/guests/*`) are immutable; `/` and `index.html` are `no-store`.
- Nothing is deployed yet.

### Before public deploy

1. **Isolated preview origins are live** and the build uses the `isolated` transport. The
   `mounted` transport is not in a public build, and imported projects are not enabled
   without isolated origins.
2. The basic flow passes on the iPhone simulator, not only in Chrome.
3. On the deployed site: `304` responses carry the isolation headers; a missing guest or worker
   URL answers 404, not `index.html`; a deep link (`/w/<id>`) loads the app on navigation.

## Testing and CI

- **Unit**: `bun test` over the pure modules (routes, paths, tree, watch filter, guests,
  languages, the JavaScript check) and over the rules that must hold without a browser: the
  project boundary and persistence of FileService (on an in-memory filesystem), the editor's
  buffers and tabs, quick-open ranking and project search, plugin isolation, recovery, and the
  workspace turnstile.
- **End to end**: Playwright against the production build (`vite preview`) in Chromium,
  Firefox and WebKit, on persistent storage, each test in a fresh browser profile. Tests
  assert outcomes; the only time limits are hang caps. Two tests are `fixme` until the gaps
  below close: two tabs on one workspace, and Bun in WebKit. The terminal draws on a canvas, so specs
  read it through `globalThis.sprockt` (see `e2e/helpers.ts`).
- **iPhone Safari**: Playwright's WebKit is not Safari. The gate for a deploy is the same boot
  flow on the iPhone simulator on the M1 Mac (slice 7).
- **CI**: two jobs. `check` runs format, lint, the JavaScript rule, types and unit tests.
  `browser` builds once and runs the three-browser suite. Caches: Bun's install cache, the
  guests (keyed on `guests.lock.json`) and Playwright's browsers.

## Known gaps

1. **Attach mode loses file bytes for programs.** With `whenBusy: "attach"` on Waffle 0.0.148
   (bash-web 0.0.114, every worker bundled from source), in Chromium and Firefox, in one tab:
   `echo hi > f.txt` creates `f.txt` and leaves it empty; `cat page.txt` on a 10-byte file the
   page wrote prints nothing; `grep from page.txt` fails with "read, output or record limit
   error"; `cat < page.txt` prints nothing. `head -1`, `cp`, Bun's `writeFileSync` and page
   reads and writes are intact, and all of it works with `whenBusy: "takeover"`. In WebKit,
   attach mode also fails `bun` with "Permission denied" and a second tab reports
   `/workspace: No such file or directory`. The fix belongs in Waffle or bash-web. Until then
   tabs do not share a workspace and the two-tab test in `e2e/boot.spec.ts` is `fixme`.
2. **Bun traps in WebKit.** In Playwright's WebKit, `bun --version` ends in a WASM trap (a
   stack of `wasm-function[...]` frames) with the browser-engine guest, in takeover mode. The
   shell, coreutils, the editor and persistence pass there. iPhone needs bun-wasm's own memory
   policy and `BUN_WASM_IPHONE_NATIVE_MEMORY` (`web/src/host-memory-policy.ts`), which this
   foundation does not apply yet. The Bun test is `fixme` on WebKit.
3. **The packages do not name their guests.** The guests are in the hash-addressed store, but
   bun-wasm's `BUN_WASM_ASSET` is `null` and bash-web ships no `shell-engine.wasm`, so
   `guests.lock.json` pins them beside the packages and moves with them by hand. When the
   packages name their guest by hash, the lock can read it from them.
4. **bun-wasm's host pieces are not package exports.** The program worker, `Previews`,
   `HostedPreviews`, the service worker, the memory policy and the dev-server coordinator live
   in bun-wasm's `web/src` and `sandbox/src`. Slice 5 builds on Waffle's public
   `waffle/browser/preview` and ports the rest; an export from bun-wasm would replace the
   path imports.
5. **Waffle has no conditional or confined file operation.** Two FileService rules are a check
   followed by an operation, with a gap between them: `writeIfUnchanged` (read, compare,
   write) and the project boundary (resolve, then read or write). Both need Waffle to do it
   in one step: a write that fails unless the file still holds the expected bytes, and
   operations that refuse to leave a given root. The fix belongs in Waffle.

## Parallel work map

Every slice owns the files listed and one spec in `e2e/`. Shared contracts are frozen unless
the slice that owns them changes them: `FileService` (slice 2), `PreviewTransport` (slice 5),
`registerEditorPlugins` (slice 3), `Route` (slice 4), `e2e/helpers.ts` (slice 7).

Slice 6 owns the integration files: `src/workspace/session.ts`, `src/workbench/Workbench.tsx`
and `src/styles.css`. The other slices do not edit them. Each exports a factory for its service
and its pane component from its own directory, keeps its CSS there, and slice 6 lands the
wiring (the import, the entry on `WorkspaceSession`, the pane in the layout).

| #   | Slice                              | Owns                                                                                                                     | Builds                                                                                                                                                                                                                                                                                                      |
| --- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Landing and templates              | `src/landing/**`, `src/templates/**`, `e2e/landing.spec.ts`                                                              | Hero, template grid (Vite+React, Next.js, Hono, Astro, SvelteKit, Vanilla TS, `Bun.serve` + `bun:sqlite`; port the file sets from bun-wasm `sandbox/template-*`), workspace switcher with rename and delete (`deleteWorkspace`), `/.sprockt/workspace.json`. Writes templates with `FileService.writeMany`. |
| 2   | File tree                          | `src/explorer/**`, `src/files/**`, `e2e/files.spec.ts`                                                                   | Create, rename, delete, upload, ZIP download, dirty markers, lazy directories (`walk`), a hardened watcher (overflow, rebind; see bun-wasm `web/src/workspace-watch.ts`).                                                                                                                                   |
| 3   | Editor                             | `src/editor/**`, `src/search/**`, `e2e/editor.spec.ts`                                                                   | Tabs, Cmd+P quick open, Cmd+F, Cmd+Shift+F project search (ripgrep is installed), syntax highlighting packages, reload of clean buffers on external change, conflict marker for dirty ones.                                                                                                                 |
| 4   | GitHub import and share links      | `src/importer/**`, `src/share/**`, `src/app/routes.ts`, `src/app/App.tsx`, `e2e/import.spec.ts`                          | `/github/...` importer (tarball fetch, subdir filter), automatic `bun install`, dev-script detection, `/s/` snapshot links.                                                                                                                                                                                 |
| 5   | Preview                            | `src/preview/**`, `src/tasks/**`, the service worker entry, `e2e/preview.spec.ts`                                        | `mounted` transport keyed by workspace and port (development builds only), URL bar, back, forward, reload, port picker, open in new tab, mobile and desktop viewport, error indicator, HMR.                                                                                                                 |
| 6   | Workbench layout and terminal tabs | `src/workbench/**`, `src/workspace/session.ts`, `src/terminal/**`, `src/styles.css`, `e2e/layout.spec.ts`                | Resizable panes, the phone pane switcher, multiple terminal tabs (`TerminalStore`), design tokens as CSS custom properties.                                                                                                                                                                                 |
| 7   | Tabs, E2E and CI                   | `e2e/helpers.ts`, `e2e/tabs.spec.ts`, `playwright.config.ts`, `.github/**`, `src/workspace/coordinator.ts`, `scripts/**` | Dev-server ownership across tabs, the iPhone simulator smoke, CI speed and caches, moving the guest pin.                                                                                                                                                                                                    |
