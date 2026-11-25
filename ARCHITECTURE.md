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
| Tabs         | Waffle `whenBusy: "attach"`                                    | The first tab hosts the filesystem; later tabs attach and share it live. When the hosting tab closes, another tab takes over inside Waffle (Known gaps, 1).     |
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
  preview/            PreviewTransport seam, mounted transport and its service worker, the client
                      script for previewed pages, PreviewPane and its toolbar
  templates/          (slice 1) starter catalog and file sets
  importer/           (slice 4) GitHub import, install and dev-script detection, share links
  tasks/              the dev-server task and dev-script detection; (slice 7) its cross-tab owner
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
| `waffle` (`@waffle-os/runtime`), `@waffle-os/relay`     | 0.0.150            | npm                                                                   |
| `waffle-base`                                           | programs-v0.0.23   | GitHub release tarball                                                |
| `bash-web`                                              | 0.0.114            | npm                                                                   |
| `bun-wasm`                                              | commit `7b25271e3` | Git dependency (not on npm); `trustedDependencies` runs its `prepare` |
| `ghostty-webgpu`                                        | 0.3.34             | npm                                                                   |
| `@singapore-editor/core`, `/solid`, `/find`, `/gutters` | 0.2.13             | npm                                                                   |
| `@singapore-editor/highlighting`                        | 0.2.16             | npm (Tree-sitter grammars load per language, on first use)            |
| `@singapore-editor/lsp`, `/lsp-plugin`                  | 0.2.13, 0.2.16     | npm                                                                   |

Guests are the WASM programs the workers run. They are published to the hash-addressed guest
store, `bun-artifacts.shaulavo.dev/<sha256>/<file>.gz`, served gzip-encoded with immutable
caching and `Access-Control-Allow-Origin: *`. The packages do not name them yet: bun-wasm's
`BUN_WASM_ASSET` is `null` and the bash-web package ships no `shell-engine.wasm` (Known gaps, 3).

- `guests.lock.json` pins `bun-browser.wasm` (bun-wasm `7b25271e3`) and `shell-engine.wasm`
  (bash-web 0.0.114) by store URL, SHA-256 and size. The URL contains the hash, so it never
  serves anything else. `tsrs-lsp.wasm` (the TypeScript language server) is pinned to its
  tagged GitHub release on the ShaulLavo/tsrs fork (`wasi-lsp-v0.1.1`), served uncompressed.
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

**Preview** (`preview/transport.ts`). The pane asks a `PreviewTransport` for everything. The
runtime reports listening ports to it (`register`, `unregister`; boot passes them from
bun-wasm's `network.listening` hook). The pane reads `servers()` and `subscribe()`, builds
URLs with `frameUrl(port, path)` and `tabUrl(port, path)`, and turns what a frame reports back
into a place with `locate(href)` and `ownsOrigin(origin, port)`. A transport belongs to one
workspace, and the workspace id is part of every route it builds: two workspaces that both run
a server on port 5173 never see each other's HTTP or WebSocket traffic.
`createPreviewTransport(workspace)` in `preview/index.ts` picks one:

- `mounted` (`preview/mounted.ts`, `preview/sw.ts`): Waffle's `PreviewRouter` plus
  `waffle/browser/service-worker`, serving `/__preview/<workspace>/<port>/` on the IDE's own
  origin. A mounted preview shares the IDE's origin, so the previewed code can reach the
  workbench and its IndexedDB. **It is a development stopgap for trusted, local projects
  only.** It exists under `vite dev` and in a build made with `VITE_SPROCKT_PREVIEWS=mounted`
  (the test build in CI). A public build does not set that and gets the inactive transport.
- `isolated` (preview-origins lane): bun-wasm's planned `RootPreviews`, whose `url(port, path)`
  returns `https://<id>-<port>-pv.sprockt.dev/…`, where `<id>` is derived from the workspace.
  Each server gets its own origin, which is what keeps a previewed project away from the IDE.
  **Isolated origins are required before any public deploy** (see "Before public deploy").
  It needs a `createIsolatedPreviewTransport` beside the mounted one and a branch in
  `createPreviewTransport`; the pane does not change.

`tabUrl` exists because an isolated preview opened directly in Safari cannot reach the IDE and
has to go through a page on our origin.

How the mounted transport works:

- **Routing by workspace.** One service worker is registered for `/__preview/`. It keeps one
  Waffle router per workspace and tags every request it passes to a tab with the workspace
  (`preview/host-protocol.ts`). A tab answers only for the workspace it has open and declines
  anything else at once. Tabs also tell the worker which workspace they host, so it asks the
  right tab first; that list only orders the asking and is rebuilt when the worker restarts.
- **Requests outside the mount.** A previewed page asks for `/src/main.tsx` or `/@vite/client`
  at the root of our origin. The worker sees which page asked and sends the request to that
  page's server.
- **The client script.** The worker adds `/preview-client.js` to every HTML response, right
  after `<head>` (`preview/html.ts`). It gives the page a `WebSocket` that reaches its own
  server: the worker hands it a byte channel, and `preview/websocket-frames.ts` speaks the
  WebSocket protocol over it. That is what makes hot reload work. It also reports the page's
  location and errors to the pane and takes "reload" and "go to" from it (`preview/bridge.ts`,
  `window.postMessage`, the same for an isolated origin), and keeps links and redirects to
  `/path` inside the mount.
- **The pane** (`preview/PreviewPane.tsx`) keeps its own back and forward list
  (`preview/history.ts`). A frame's browser history is shared with the IDE page, so stepping
  through it could walk the IDE itself back.
- **The two scripts** (`/preview-sw.js`, `/preview-client.js`) are built as classic scripts by
  `preview/vite-plugin.ts`: a service worker has to sit at a fixed path above its scope, and
  module service workers are not available in every browser we support.

What a mounted preview cannot do, and an isolated origin can: run an app whose client router
owns `/` (the page lives under `/__preview/…`), load cross-origin files that send no CORP or
CORS header (the IDE is cross-origin isolated and its frames have to be too), and keep cookies
and storage apart from the IDE's.

**Dev server task** (`tasks/dev-server.ts`). The pane's start button asks the importer's
project detection (`importer/detect`, through `tasks/detect.ts`) what starts this project: a
`dev`, `start` or `serve` script, or a server entry file. It runs `bun install` first when the
project has a `package.json` and no `node_modules`, then the command, in its own shell on the
workspace's runtime. It is `running` once a port listens. Terminals are separate shells, so
stopping the task never touches what was started by hand.

One tab of a workspace runs the task (`tasks/dev-server-line.ts`, on
`workspace/coordinator.ts`). Asking for the server stands in the workspace's line; the tab that
gets the lease starts the process and announces this tab's ports. The other tabs list those
ports, show the same preview address (the service worker asks each tab of the workspace until
one has the port), and stand behind the owner, so one of them starts the server when the
owner's tab closes. Only the owner has a stop button. A server stopped on purpose, or one that
ended by itself, is announced as `down` before its lease ends, and the tabs behind it leave the
line instead of restarting it.

**Language servers** (`editor/plugins.ts`). `registerEditorPlugins(provider)`: a provider gets
`{ runtime, projectRoot, rootUri, signal, openFile }` and returns Singapore `EditorPlugin`s, or
`{ plugins, dispose }`, synchronously or not. The editor never waits for a provider: it opens
at once with its built-in plugins (syntax, find, gutters), and a provider's plugins are added
to the running editor (`Editor.addPlugin`) when it delivers, so the text on screen and its undo
history are untouched. A provider registered while an editor is open reaches it too, and
unregistering removes its plugins. Each provider runs inside its own boundary, so one that
throws or never answers only loses its own plugins. `signal` aborts and every `dispose` runs
when the editor closes or another tab takes the workspace over, including for a set that
arrives late. `openFile(path, { line, column })` opens an absolute project path in a tab, which
is how go-to-definition reaches other files and `node_modules`.
Document ids are absolute workspace paths, so a server sees `file:///workspace/src/main.ts`.

**TypeScript IntelliSense** (`src/lsp/`). `main.tsx` registers one provider; its code is a lazy
chunk. It waits until the project has a TypeScript or JavaScript file of its own (not in
`node_modules`), downloads and verifies the tsrs guest, installs it at `/usr/bin/tsrs-lsp`, and
only then creates the plugin, because the plugin starts the server as it mounts. `glue.ts` is
the LSP lane's glue: `startCommand` with the process's stdio as an LSP transport, restarts on a
crash, one server per workspace from a page-wide pool, `disposeLanguageServers()` when the
editor's providers stop. tsrs cannot watch files under WASI, so `watch.ts` forwards Waffle's
watch events as `workspace/didChangeWatchedFiles`. `servers.ts` is the seam for a second
server (typescript-language-server under Bun).

## Tabs

The design is `whenBusy: "attach"`: the first tab hosts the filesystem; later tabs attach as
peers and read, write and watch the same live tree. Host loss fails over inside Waffle.

`TAB_POLICY` (`runtime/tab-policy.ts`) is `"attach"`, and `runtime/boot.ts` opens with it. The
wait-and-ask path ("Workspace lifetime") stays as the `"takeover"` fallback, and its tests run
only under that policy; `e2e/tabs.spec.ts` and the two-tab explorer test run only under attach.
Under attach the workbench never offers to take a workspace over.

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
  assert outcomes; the only time limits are hang caps. The terminal draws on a canvas, so specs
  read it through `globalThis.sprockt` (see `e2e/helpers.ts`).
- **iPhone Safari**: Playwright's WebKit is not Safari. The gate for a deploy is the same boot
  flow on the iPhone simulator on the M1 Mac (slice 7).
- **CI**: two jobs. `check` runs format, lint, the JavaScript rule, types and unit tests.
  `browser` builds once and runs the three-browser suite. Caches: Bun's install cache, the
  guests (keyed on `guests.lock.json`) and Playwright's browsers. The browser job builds with
  `VITE_SPROCKT_PREVIEWS=mounted`, so `e2e/preview.spec.ts` and `e2e/hmr.spec.ts` have a
  transport; run them locally the same way. The hot-reload test installs React and Vite from
  the npm registry inside the browser, so it needs the network.

## Known gaps

1. **Attach mode under load in WebKit.** With Waffle 0.0.150 in Playwright's WebKit, when many
   workspaces boot at once (ten parallel test workers), about half the shells fail to start
   with "filesystem errno 11" (sometimes 22), and the file watcher fails with the same error.
   Four workers and one worker pass, and the takeover policy passes under the same load. Chromium
   and Firefox pass. The cause is in Waffle's attach mode; the PR that flipped the policy has
   the reproduction.
2. **Runtime.dispose() after takeover keeps the filesystem worker.** Waffle 0.0.148 to 0.0.150:
   after ownership loss, disposal rejects ("Runtime disposal failed") and the worker stays. The
   test in `e2e/layout.spec.ts` is `fixme`; it only applies under the takeover policy.
3. **The packages do not name their guests.** The guests are in the hash-addressed store, but
   bun-wasm's `BUN_WASM_ASSET` is `null` and bash-web ships no `shell-engine.wasm`, so
   `guests.lock.json` pins them beside the packages and moves with them by hand. When the
   packages name their guest by hash, the lock can read it from them.
4. **bun-wasm's host pieces are not package exports.** The program worker, `Previews`,
   `HostedPreviews`, the service worker, the memory policy and the dev-server coordinator live
   in bun-wasm's `web/src` and `sandbox/src`. Slice 5 builds on Waffle's public
   `waffle/browser/preview` and ports the rest; an export from bun-wasm would replace the
   path imports.
5. **Waffle has no conditional or confined file operation.** Several FileService rules are a
   check followed by an operation: `writeIfUnchanged` (read, compare, write), create, move and
   rename (destination free, then write or rename), and the project boundary (resolve, then
   read or write). Across tabs, FileService makes each check-and-act one step with Web Locks
   (`files/path-locks.ts`, `sprockt:<id>:path:<path>`):
   - an operation locks its own paths exclusively and every folder above them shared, so a
     folder move or delete waits for writes inside the folder and keeps new ones out;
   - locks are keyed by real paths (links on the way followed), so two spellings of one file
     through a folder link take the same lock; under the locks the paths are resolved again,
     and a write whose folder was moved or deleted meanwhile fails (`FolderGoneError`, a
     conflict for an editor save) instead of recreating the folder;
   - all locks of an operation are taken in one sorted order, so two operations never wait on
     each other in a cycle; a bulk write locks the folder holding all its files once (1,000
     files: 0.4 to 1.1 s on the PC).

   Programs in a terminal do not take these locks, and a link swapped by one between the
   boundary check and the operation is not caught. Closing both needs Waffle to do it in one
   step: a write that fails unless the file still holds the expected bytes, a rename that
   refuses to replace, and operations that refuse to leave a given root.
   - Upload, listing and move resolve the path again inside the operation after the boundary
     check, so a link changed in between can lead somewhere else.
   - Waffle returns a failed change to its caller and keeps the same error to throw at the next
     flush. FileService retries a flush that throws an error its own operation already reported,
     and lets any other error fail the save state; Waffle should report a failure once.
6. **Only Bun's listeners are previewed, and other tabs see only the dev-server task's.** Ports
   are reported by bun-wasm's adapter, so a server started by another kind of program would not
   appear. Other tabs learn of ports through the dev-server task's lease: a server started by
   hand in a terminal shows in its own tab only, unless that tab also runs the task. The
   two-tab tests (`e2e/dev-server-tabs.spec.ts`) run only with the attach policy (gap 1); they
   pass when it is switched on locally.
7. **`bun --hot` in bun-wasm is narrower than Bun's.** The task starts a bare entry file with
   `bun --hot <file>` (the importer's detection). bun-wasm refuses that for a file with no
   `import` or `export` ("--hot requires an ESM graph") and for a server with routes or
   WebSocket handlers ("--hot does not support routes, WebSockets, TLS or Unix listeners"), and
   then waits for an edit, so the task stays on "starting" with the error under it.

6. **A save is unsaved until storage holds it.** Waffle acknowledges a write from memory. If its
   flush fails, or the files come back from storage (a hosting tab closed) without it, the
   editor keeps the buffer's text as unsaved and shows a conflict against what storage holds,
   instead of reloading the older text. A flush that the new hosting tab answers before the
   editor sees the files change can still hide a lost save; Waffle would have to report that
   its storage changed hands.

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
