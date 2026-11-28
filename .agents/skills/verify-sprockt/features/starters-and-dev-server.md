# Starters and dev server

Seven built-in starter workspaces (`vite-react`, `next-app`, `hono`, `astro`, `sveltekit`, `vanilla`, `bun-sqlite`) plus Blank, seeded into persistent IndexedDB storage and booted with real `bun install` and `bun run dev`.

## Sub-features

- Template catalog (`src/templates/catalog.ts`) with WASI-compatible dependency pins and `tsconfig.json` files.
- Workspace seeding (`src/templates/seed.ts`): writes `/.sprockt/workspace.json` metadata, an incomplete-import safety marker cleared after final flush, and a `pendingImport` plan when project detection finds a dev command.
- First-open auto-start (`src/workspace/session/first-open.ts`): `WorkspaceSession` owns `devServer` and consumes `pendingImport` once when the workspace opens, starting `bun install` and the dev server without waiting for the Preview pane to mount or open (including on phones).
- Preview toolbar and empty-state **Start dev server** trigger (`preview-start`, `preview-task`), streaming install/build logs (`preview-task-output`), status bar port indicator (`dev-server`), preview reload (`wb-preview-reload`), and automatic port detection (`wb-preview-port-select`).

## How to get to it (user POV)

Click any starter card on `/` (for example Vite + React, `template-vite-react`). Once the workspace boots to `ready`, `bun install` and the dev server start on their own and render in the Preview pane. On a phone, the server starts in the background before you switch to the Preview tab.

First-open plans run once per workspace because `pendingImport` is cleared and flushed when consumed. If you reload the workspace tab later, click **Start dev server** in the Preview pane (or run `bun install && bun run dev` in the Terminal). Reloading only the preview iframe (`wb-preview-reload`) reloads the app page while keeping the dev server running.

## Driving it with agent:browser

```bash
bun run agent:browser scenario starter-dev-server
bun run agent:browser scenario starter-dev-server --viewport phone
bun run agent:browser scenario starter-dev-server --starter vanilla
bun run agent:browser scenario starter-dev-server --starter hono --engine webkit
bun run agent:browser scenario starter-dev-server --url https://sprockt.dev/ --live
```

Confirm:

1. The starter starts automatically without clicking **Start dev server**. On phone (`--viewport phone`), `preview-task` reaches `running` and `wb-preview-port-select` attaches before the scenario taps **Preview**.
2. `cold-boot.json` records `workspaceOpenedMs`, `workbenchReadyMs`, `serverListeningMs`, `previewRenderedMs`, and resource timings for `.wasm`, `/api/github/`, and boot/worker assets.
3. `01-auto-started-preview.png` shows the real app rendered inside `wb-preview-iframe` (never a Rolldown `wasm32` crash).
4. For `vite-react`, clicking preview reload (`wb-preview-reload`) resets the counter from `count is 1` to `count is 0` while the server keeps running. On desktop, `02-hmr-updated.png` shows live heading text updated after editing `src/App.tsx` with `count is 1` preserved and zero `lsp-plugin-error` ranges.

## Gotchas

- Vite 8 switches to Rolldown native bindings, which crash on WASI `wasm32` and iOS Safari (`Unsupported architecture on Linux: wasm32`). All Vite starters must remain on patched Vite 7 (`vite@7.3.8`, `@vitejs/plugin-react@5.2.0`), enforced by `src/templates/catalog.test.ts`.
- Astro must keep `ASTRO_TELEMETRY_DISABLED=1` in its `dev` and `build` scripts so telemetry requests do not fail CORS under COEP.
- A workspace reload does not auto-start the dev server again (`e2e/preview.spec.ts` asserts `preview-start` is visible after `page.reload()`). Opening a workbench without verifying that the auto-started server actually listens and renders does not verify starter execution; run `starter-dev-server` when touching templates, runtime boot, first-open startup, or preview plumbing.
