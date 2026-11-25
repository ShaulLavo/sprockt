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
  editor/             EditorPane, EditorStore, language ids, plugin mount hook
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
  An editor buffer is a cache with a dirty flag; saving goes through `FileService.write`.
- **One change signal.** `FileService.revision` moves when project files change, whatever the
  source: a page write, the shell, Bun, or another tab. It is fed by a recursive Waffle watch
  (`FilesystemClient.watch`) and coalesced over 50 ms. The explorer re-lists on it; clean
  editor buffers reload on it (slice 3); `node_modules` and `.git` churn is ignored.
- **Saving is explicit state.** Waffle acknowledges writes from memory. `FileService` flushes
  after every change and exposes `saveState` (`saved`, `saving`, `failed`), shown in the status
  bar. Tests wait for `saved` before a reload; so should "close tab" prompts.
- **Stores are factories, not globals.** `createEditorStore()`, `createFileService(runtime)`:
  each returns accessors and methods. The router is the only module-level signal.
- **Workspaces are discovered, not indexed.** The landing page lists
  `storedWorkspaces("fast")` filtered by the `sprockt-` prefix. Names and metadata (template,
  last opened) go in a `/.sprockt/workspace.json` file inside the workspace (slice 1), so
  there is no second database to keep in step.

## Runtime boot

`runtime/boot.ts`, in order:

1. `createRuntime({ filesystem: { mode: "fast", name: "sprockt-<id>", workerURL, whenBusy: TAB_POLICY }, memoryGroups })`.
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

| Package                                             | Pin                | Source                                                                |
| --------------------------------------------------- | ------------------ | --------------------------------------------------------------------- |
| `waffle` (`@waffle-os/runtime`), `@waffle-os/relay` | 0.0.148            | npm                                                                   |
| `waffle-base`                                       | programs-v0.0.23   | GitHub release tarball                                                |
| `bash-web`                                          | 0.0.114            | npm                                                                   |
| `bun-wasm`                                          | commit `7b25271e3` | Git dependency (not on npm); `trustedDependencies` runs its `prepare` |
| `ghostty-webgpu`                                    | 0.3.34             | npm                                                                   |
| `@singapore-editor/core`, `/solid`                  | 0.2.13             | npm                                                                   |

Guests are the WASM programs the workers run. Neither bun-wasm nor bash-web publishes them:
bun-wasm's `BUN_WASM_ASSET` is `null`, the `bun-artifacts.shaulavo.dev` store has no object for
the current browser guest, and the bash-web package ships no `shell-engine.wasm`. Until they do:

- `guests.lock.json` pins `bun-browser.wasm` and `shell-engine.wasm` by URL, SHA-256 and size.
  The URLs point at `bun.sprockt.dev`, which serves the guests built for the pinned bun-wasm
  commit, but with `Cross-Origin-Resource-Policy: same-origin`, so a browser on `sprockt.dev`
  cannot load them from there.
- `bun run guests` downloads, verifies and stages them at `public/guests/<sha256>/<name>`.
  Sprockt serves them from its own origin on content-addressed, immutable URLs.
- `bun.sprockt.dev` is mutable: when it deploys a different guest the download fails its hash
  check. `SPROCKT_GUEST_CACHE` (CI: an Actions cache keyed on the lock) keeps verified copies.
  Moving the pin means moving the lock and the bun-wasm commit together.
- The real fix is upstream publication to the hash-addressed store; then the lock only changes
  its URLs. JSC and QuickJS engine guests, `bun-tools.wasm` (lint, fmt) and Python or Git
  programs are not pinned yet; add them to the lock when a slice needs them.

## Seams for the sibling lanes

**Preview** (`preview/transport.ts`). The pane asks a `PreviewTransport` for everything:
`servers()`, `subscribe()`, `frameUrl(port, path)`, `tabUrl(port, path)`, `onReloadNeeded()`.
Milestone 1 ships an inactive transport. Slice 5 adds `mounted`: Waffle's
`PreviewRouter({ baseURL, prefix })` plus `waffle/browser/service-worker`, serving
`/__preview/<port>/` on our origin. The preview-origins lane then adds `isolated`: bun-wasm's
planned `RootPreviews`, whose `url(port, path)` returns `https://<id>-<port>-pv.sprockt.dev/…`,
selected by build-time configuration. `tabUrl` exists because an isolated preview opened
directly in Safari cannot reach the IDE and has to go through a page on our origin.

**Language servers** (`editor/plugins.ts`). `registerEditorPlugins(provider)`: a provider gets
`{ runtime, projectRoot, rootUri }` and returns Singapore `EditorPlugin`s, synchronously or
not. `EditorPane` resolves all providers before it creates the editor; a failing provider only
loses its own plugins. Document ids are absolute workspace paths, so a server sees
`file:///workspace/src/main.ts`. The LSP lane adds `src/lsp/typescript.ts` (its
stdio transport plus `createLanguageServerPlugin`) and one `registerEditorPlugins` call.

## Tabs

The design is `whenBusy: "attach"`: the first tab hosts the filesystem; later tabs attach as
peers and read, write and watch the same live tree. Host loss fails over inside Waffle.

Today `TAB_POLICY` in `runtime/boot.ts` is `"takeover"`, because attach mode in Waffle 0.0.148
loses file bytes for programs (Known gaps, 1). The newest tab takes the workspace and the
older tab's filesystem stops. Everything below describes the attach design the slices build
toward; flipping the constant is the only change in this repository.

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

`app/routes.ts` parses and prints all of them and is unit tested; unknown paths render "not
found" and never guess. The workbench is a lazy chunk, so the landing page loads none of the
editor, terminal or runtime code.

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
- Nothing is deployed yet. A deploy is done only when the basic flow also passes on the iPhone
  simulator.

## Testing and CI

- **Unit**: `bun test` over the pure modules (routes, paths, tree, watch filter, guests,
  languages, the JavaScript check).
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
   `TAB_POLICY` is `"takeover"` and the two-tab test in `e2e/boot.spec.ts` is `fixme`.
2. **Bun traps in WebKit.** In Playwright's WebKit, `bun --version` ends in a WASM trap (a
   stack of `wasm-function[...]` frames) with the browser-engine guest, in takeover mode. The
   shell, coreutils, the editor and persistence pass there. iPhone needs bun-wasm's own memory
   policy and `BUN_WASM_IPHONE_NATIVE_MEMORY` (`web/src/host-memory-policy.ts`), which this
   foundation does not apply yet. The Bun test is `fixme` on WebKit.
3. **No published guests** (see "Packages and guests").
4. **bun-wasm's host pieces are not package exports.** The program worker, `Previews`,
   `HostedPreviews`, the service worker, the memory policy and the dev-server coordinator live
   in bun-wasm's `web/src` and `sandbox/src`. Slice 5 builds on Waffle's public
   `waffle/browser/preview` and ports the rest; an export from bun-wasm would replace the
   path imports.

## Parallel work map

Every slice owns the files listed and one spec in `e2e/`. Shared contracts are frozen unless
the slice that owns them changes them: `FileService` (slice 2), `PreviewTransport` (slice 5),
`registerEditorPlugins` (slice 3), `Route` (slice 4), `e2e/helpers.ts` (slice 7). A slice adds
its service to `WorkspaceSession` and its pane to `Workbench.tsx` with one line each; those two
files and `src/styles.css` belong to slice 6, and other slices keep their CSS in their own
directory.

| #   | Slice                              | Owns                                                                                                                     | Builds                                                                                                                                                                                                                                                                                                      |
| --- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Landing and templates              | `src/landing/**`, `src/templates/**`, `e2e/landing.spec.ts`                                                              | Hero, template grid (Vite+React, Next.js, Hono, Astro, SvelteKit, Vanilla TS, `Bun.serve` + `bun:sqlite`; port the file sets from bun-wasm `sandbox/template-*`), workspace switcher with rename and delete (`deleteWorkspace`), `/.sprockt/workspace.json`. Writes templates with `FileService.writeMany`. |
| 2   | File tree                          | `src/explorer/**`, `src/files/**`, `e2e/files.spec.ts`                                                                   | Create, rename, delete, upload, ZIP download, dirty markers, lazy directories (`walk`), a hardened watcher (overflow, rebind; see bun-wasm `web/src/workspace-watch.ts`).                                                                                                                                   |
| 3   | Editor                             | `src/editor/**`, `src/search/**`, `e2e/editor.spec.ts`                                                                   | Tabs, Cmd+P quick open, Cmd+F, Cmd+Shift+F project search (ripgrep is installed), syntax highlighting packages, reload of clean buffers on external change, conflict marker for dirty ones.                                                                                                                 |
| 4   | GitHub import and share links      | `src/importer/**`, `src/share/**`, `src/app/routes.ts`, `src/app/App.tsx`, `e2e/import.spec.ts`                          | `/github/...` importer (tarball fetch, subdir filter), automatic `bun install`, dev-script detection, `/s/` snapshot links.                                                                                                                                                                                 |
| 5   | Preview                            | `src/preview/**`, `src/tasks/**`, the service worker entry, `e2e/preview.spec.ts`                                        | `mounted` transport, URL bar, back, forward, reload, port picker, open in new tab, mobile and desktop viewport, error indicator, HMR.                                                                                                                                                                       |
| 6   | Workbench layout and terminal tabs | `src/workbench/**`, `src/terminal/**`, `src/styles.css`, `e2e/layout.spec.ts`                                            | Resizable panes, the phone pane switcher, multiple terminal tabs (`TerminalStore`), design tokens as CSS custom properties.                                                                                                                                                                                 |
| 7   | Tabs, E2E and CI                   | `e2e/helpers.ts`, `e2e/tabs.spec.ts`, `playwright.config.ts`, `.github/**`, `src/workspace/coordinator.ts`, `scripts/**` | Dev-server ownership across tabs, the iPhone simulator smoke, CI speed and caches, moving the guest pin.                                                                                                                                                                                                    |
