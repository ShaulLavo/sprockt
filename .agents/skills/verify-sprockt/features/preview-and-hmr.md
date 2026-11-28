# Live preview and HMR

In-browser preview pane (`src/preview/`) tunneling HTTP and WebSocket HMR traffic from dev servers running inside Waffle/Bun.

## Sub-features

- Two transports: `mounted` (trusted dev, test, and private-preview builds via `VITE_SPROCKT_PREVIEWS=mounted`) and `isolated` (production `<id>-<port>-pv.sprockt.dev` origins via `VITE_SPROCKT_PREVIEW_DOMAIN`).
- Preview toolbar (`.wb-preview-toolbar`): Back, Forward, Reload (`wb-preview-reload`), URL input (`wb-preview-url-input`), port switcher (`wb-preview-port-select`), viewport presets, error counter (`wb-preview-errors`), dev-server task button (`preview-task`), and Open-in-tab (`wb-preview-open-tab`).
- Empty state with **Start dev server** (`preview-start`) and live iframe (`wb-preview-iframe`).

## How to get to it (user POV)

Fresh starters and GitHub imports auto-start their dev server on first open, even on a phone before you switch to the Preview tab. Click Reload (`wb-preview-reload`) to reload the previewed page without stopping the server. Edit a source file in the editor and watch HMR update the preview without losing React state.

Because first-open plans run once per workspace, reloading the workspace tab later leaves the server stopped until you click **Start dev server** in the Preview pane.

## Driving it with agent:browser

```bash
VITE_SPROCKT_PREVIEWS=mounted bun run build
bun run agent:browser scenario starter-dev-server
bun run agent:browser scenario starter-dev-server --viewport phone
bun run agent:browser scenario starter-dev-server --engine webkit
bun run agent:browser scenario starter-dev-server --url https://sprockt.dev/ --live
```

Inspect `cold-boot.json`, `01-auto-started-preview.png`, and (on desktop) `02-hmr-updated.png` to confirm the preview iframe auto-starts and renders real content, preview reload resets the counter while the server keeps running, and typing in `src/App.tsx` updates the heading via HMR while keeping React state (`count is 1`).

## Gotchas

- A plain `bun run build` without `VITE_SPROCKT_PREVIEWS=mounted` or `VITE_SPROCKT_PREVIEW_DOMAIN` intentionally builds with previews disabled (`e2e/previews-off.spec.ts`). Always set `VITE_SPROCKT_PREVIEWS=mounted` before local `agent:browser` runs that test dev servers.
- `starter-dev-server` drives `wb-preview-iframe` via `frameLocator` against local mounted previews and live isolated previews on Chromium and WebKit. Playwright Firefox's reload hang applies to isolated preview frames (see `ARCHITECTURE.md` Known gaps; mounted previews and HMR specs run in Firefox), and Playwright WebKit has an occasional Vite startup flake under heavy load (about 1 in 15 runs); re-run once if WebKit stalls before listening.
- Workspace reload vs preview reload: reloading the workspace tab requires a manual start because `pendingImport` runs once per workspace, while clicking `wb-preview-reload` keeps the running server alive.
- Two buttons carry the label "Start dev server" when stopped (toolbar task button and empty-state CTA). Use `SELECTORS.preview.startButton` (`[data-testid="preview-start"]`) or `.first()` instead of an ambiguous text locator.
- Respect the cookie invariant in `AGENTS.md`: isolated previews stay on `*-pv.sprockt.dev` only while `sprockt.dev` sets zero cookies.
