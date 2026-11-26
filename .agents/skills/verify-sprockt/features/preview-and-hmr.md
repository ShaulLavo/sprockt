# Live preview and HMR

In-browser preview pane (`src/preview/`) tunneling HTTP and WebSocket HMR traffic from dev servers running inside Waffle/Bun.

## Sub-features

- Two transports: `mounted` (trusted dev/test/private-preview builds via `VITE_SPROCKT_PREVIEWS=mounted`) and `isolated` (production `<id>-<port>-pv.sprockt.dev` origins via `VITE_SPROCKT_PREVIEW_DOMAIN`).
- Preview toolbar (`preview-bar`): Back/Forward/Reload, URL input (`preview-url`), port switcher (`preview-port`), viewport presets, error counter (`preview-errors`), dev-server task button (`preview-task`), and Open-in-tab (`preview-open`).
- Empty state with **Start dev server** (`preview-start`) and live iframe (`preview-frame`).

## How to get to it (user POV)

In any starter workspace, open the Preview pane (right side on desktop, **Preview** tab on phone) and click **Start dev server**. Interact with the running app inside the preview frame, then edit a source file in the editor and watch HMR update the preview without losing React state.

## Driving it with agent:browser

```bash
VITE_SPROCKT_PREVIEWS=mounted bun run build
bun run agent:browser scenario starter-dev-server
bun run agent:browser scenario starter-dev-server --engine webkit
```

Inspect `02-dev-server-rendered.png` and `03-hmr-updated.png` to confirm the preview iframe renders real content and updates live after typing in the editor while preserving React state (`count is 1`).

## Gotchas

- A plain `bun run build` without `VITE_SPROCKT_PREVIEWS=mounted` or `VITE_SPROCKT_PREVIEW_DOMAIN` intentionally builds with previews disabled (`e2e/previews-off.spec.ts`). Always set `VITE_SPROCKT_PREVIEWS=mounted` before local `agent:browser` runs that test dev servers.
- `starter-dev-server` drives `preview-frame` via `frameLocator` against local/mounted previews on Chromium and WebKit. Playwright Firefox's reload hang applies to **isolated** preview frames (see `ARCHITECTURE.md` Known gaps; mounted previews and HMR specs run in Firefox), and Playwright WebKit has an occasional Vite startup flake under heavy load (~1 in 15 runs); re-run once if WebKit stalls before listening.
- Notice there are two buttons labeled "Start dev server" in the DOM when stopped (toolbar task button + empty-state CTA). Use `SELECTORS.preview.startButton` (`[data-testid="preview-start"]`) or `.first()` instead of an ambiguous text locator.
- Respect the cookie invariant in `AGENTS.md`: isolated previews stay on `*-pv.sprockt.dev` only while `sprockt.dev` sets zero cookies.
