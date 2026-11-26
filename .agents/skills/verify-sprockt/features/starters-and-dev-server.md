# Starters and dev server

Seven built-in starter workspaces (`vite-react`, `next-app`, `hono`, `astro`, `sveltekit`, `vanilla`, `bun-sqlite`) plus Blank, seeded into persistent IndexedDB storage and booted with real `bun install` + `bun run dev`.

## Sub-features

- Template catalog (`src/templates/catalog.ts`) with WASI-compatible dependency pins and `tsconfig.json` files.
- Workspace seeding (`/.sprockt/workspace.json` metadata + incomplete-import safety marker).
- Preview toolbar & empty-state **Start dev server** trigger (`preview-start`), streaming build/install logs (`preview-task-output`), and automatic port detection (`preview-port`).

## How to get to it (user POV)

Click any starter card on `/` (for example **Vite + React**, `template-vite-react`). Wait for the workbench to reach `ready`, then click **Start dev server** in the Preview pane (or run `bun install && bun run dev` in the Terminal).

## Driving it with agent:browser

```bash
bun run agent:browser scenario starter-dev-server
bun run agent:browser scenario starter-dev-server --starter vanilla
bun run agent:browser scenario starter-dev-server --starter hono --engine webkit
```

Confirm:

1. `01-starter-opened-clean-lsp.png` shows the initial file open with zero false-alarm red squiggles.
2. `02-dev-server-rendered.png` shows the real app rendered inside `preview-frame` (never a Rolldown `wasm32` crash).
3. `03-hmr-updated.png` shows live preview text updated after editing `src/App.tsx`.

## Gotchas

- Vite 8 switches to Rolldown native bindings, which crash on WASI `wasm32` / iOS Safari (`Unsupported architecture on Linux: wasm32`). All Vite starters must remain on patched Vite 7 (`vite@7.3.8`, `@vitejs/plugin-react@5.2.0`), enforced by `src/templates/catalog.test.ts`.
- Astro must keep `ASTRO_TELEMETRY_DISABLED=1` in its `dev` and `build` scripts so telemetry requests do not fail CORS under COEP.
- Opening a workbench without clicking **Start dev server** does NOT verify starter execution; always run `starter-dev-server` when touching templates, runtime boot, or preview plumbing.
