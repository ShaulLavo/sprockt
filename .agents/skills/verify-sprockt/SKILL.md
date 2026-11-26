---
name: verify-sprockt
description: Drive the real running Sprockt browser IDE like a user and capture surviving visual and runtime evidence — screenshots, console and network errors, layout overflow checks, real starter dev server boots, live HMR edits, LSP diagnostics, and mobile touch checks. Use before calling any UI, starter, LSP, terminal, preview, or mobile change done.
---

# Verify Sprockt

Sprockt is a React 19 + Vite client IDE running Waffle, `bun-wasm`, `bash-web`, Singapore, `tsrs-lsp`, and Ghostty WebGPU directly in the browser. One CLI drives it: `bun run agent:browser`. Every verb writes an isolated evidence directory and prints a one-screen `summary.md`.

## Launch

Build the app once with mounted previews enabled for local verification:

```bash
VITE_SPROCKT_PREVIEWS=mounted bun run build
```

When you run `bun run agent:browser` without `--url`, the CLI allocates a free loopback port (`127.0.0.1`), starts a private throwaway `vite preview` server serving `dist/` with the required COOP/COEP headers (`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`), captures server stdout/stderr to `server.log`, and stops only its own process when the run finishes.

Pass `--url <URL>` to verify a deployed preview (for example `https://y78x.shaulavo.dev`) or a live server already running on another port. Writing scenarios refuse `sprockt.dev` and `*.sprockt.dev` production URLs; only `look` and `readOnly: true` scenarios run against production hosts.

Switch engines with `--engine chromium|webkit|firefox`, viewports with `--viewport desktop|phone|WxH`, and color schemes with `--scheme light|dark`. Use `--headed` when you want a real GPU window instead of headless capture.

## Doctor

Run doctor first whenever starting a verification pass or after a failed drive:

```bash
bun run agent:browser look --doctor
```

Doctor passes only when:

- the page renders with `crossOriginIsolated === true` (SharedArrayBuffer available for Waffle/WASI),
- horizontal overflow is `0px`,
- no visible `[role="alert"]` banners or broken `<img>` elements exist, and
- `observed.json` records zero `pageErrors` and zero `consoleErrors`.

Run doctor on both desktop and phone when verifying responsive work:

```bash
bun run agent:browser look --doctor --viewport desktop --scheme light
bun run agent:browser look --doctor --viewport phone --scheme dark --engine webkit
```

## Drive

```bash
bun run agent:browser list
bun run agent:browser look [--doctor] [--url URL] [--viewport desktop|phone|WxH] [--scheme light|dark] [--engine chromium|webkit|firefox] [--selector CSS]
bun run agent:browser scenario <name> [--url URL] [--viewport desktop|phone|WxH] [--scheme light|dark] [--engine chromium|webkit|firefox] [--starter ID]
```

Built-in scenarios live in `scripts/agent/scenarios/`:

- `landing-desktop-mobile` (`read-only`): checks landing page at `1440×900` and `390×844` in light and dark modes, zero overflow, all 7 starter cards present.
- `starter-dev-server`: opens a starter (`--starter vite-react` by default), proves zero initial false-alarm `tsrs` red squiggles before install, clicks **Start dev server**, waits for real `bun install` + dev server render, clicks the interactive counter, edits `src/App.tsx`, and proves live HMR updates the preview iframe.
- `workbench-tabs-and-explorer`: filters the file tree, opens a second tab, creates and edits a new file, and opens the command palette.
- `mobile-workbench`: runs at `390×844` with real touch input (`hasTouch: true`, `.tap()`), verifies tab switching never focuses the editor (keeping the soft keyboard closed), explicit editor tap focuses it, and toggling Light → Dark while the Terminal pane is hidden syncs Ghostty to a dark theme on reveal.
- `github-import-and-share`: checks landing repo input validation and round-trips a `/s#share=...` snapshot into a fresh isolated browser context.

All stable selectors live in `scripts/agent/selectors.ts`. When adding coverage for a new surface, add selectors there and add a scenario under `scripts/agent/scenarios/`.

## Evidence

Every run creates `<OS temp>/sprockt-evidence/<stamp>-<verb>-<label>/` (override with `SPROCKT_EVIDENCE_ROOT` or `--evidence-root`) containing:

- `summary.md` — concise PASS/FAIL report printed to stdout
- `01-*.png`, `02-*.png`, ... — viewport and step screenshots
- `observed.json` — `pageErrors`, `consoleErrors`, `consoleWarnings`, `failedRequests`, `badResponses`
- `layout.json` — viewport dimensions, `overflowX`, `crossOriginIsolated`, theme state, visible alerts, broken images, iframe geometry
- `server.log` — throwaway `vite preview` stdout/stderr (for local runs)

Proof standards:

- Drive the real user path (click **Start dev server**, tap real tabs, edit real files) — never trust "it compiles" or a workbench-open-only smoke.
- Always open captured screenshots with an image-reading tool (`read_file`) and inspect them visually; a screenshot nobody looked at is not evidence.
- When testing on iOS Simulator (iPhone Safari), use the T3 `device_*` tools and `agent-device` CLI against the live preview URL in addition to Playwright WebKit.

## Cleanup

The CLI closes its browser and stops only the throwaway `vite preview` child it spawned. It never calls `pkill` and never deletes evidence directories; evidence survives teardown so failures and screenshots can be inspected afterward.

## Helpers

- `scripts/agent/selectors.ts` — canonical `data-testid` and `aria-label` selectors for every surface.
- `scripts/agent/args.ts` — viewport presets (`desktop` = `1440×900`, `phone` = `390×844` touch), engine selection, and URL handling.
- `scripts/agent/server.ts` — free-port throwaway `vite preview` lifecycle.
- `scripts/agent/evidence.ts` — screenshot capture, layout snapshot, and error observer.
- `scripts/iphone-smoke.ts` — existing real iPhone simulator smoke script.

## Feature map

[`features/README.md`](features/README.md) indexes Sprockt's 8 user-facing surfaces. Check every feature file affected by your change before calling work done.
