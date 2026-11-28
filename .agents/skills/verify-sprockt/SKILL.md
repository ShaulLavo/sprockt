---
name: verify-sprockt
description: Drive the real running Sprockt browser IDE like a user and capture surviving visual and runtime evidence: screenshots, cold-boot timings, console and network errors, layout overflow checks, starter auto-start and HMR, real GitHub archive imports, LSP diagnostics, and mobile touch checks. Use before calling any UI, starter, import, LSP, terminal, preview, or mobile change done.
---

# Verify Sprockt

Sprockt is a React 19 + Vite client IDE running Waffle, `bun-wasm`, `bash-web`, Singapore, `tsrs-lsp`, and Ghostty WebGPU in the browser. One CLI drives it: `bun run agent:browser`. Every verb writes an isolated evidence directory and prints a one-screen `summary.md`.

## Launch

Build the app once with mounted previews enabled for local verification:

```bash
VITE_SPROCKT_PREVIEWS=mounted bun run build
```

When you run `bun run agent:browser` without `--url`, the CLI allocates a free loopback port on `127.0.0.1`, starts a private throwaway `vite preview` server serving `dist/` with the required COOP/COEP headers (`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`), writes server stdout and stderr to `server.log`, and stops only its own process when the run finishes.

Pass `--url <URL>` to check a deployed preview (for example `https://y78x.shaulavo.dev`) or a live server already running on another port. Writing scenarios refuse `sprockt.dev` and `*.sprockt.dev` URLs by default, including redirects to those hosts. Only `look` and `readOnly: true` scenarios run against production hosts without opt-in.

To run live production checks, pass the exact landing URL with `--live`:

```bash
bun run agent:browser scenario starter-dev-server --url https://sprockt.dev/ --live
bun run agent:browser scenario github-real-repo --url https://sprockt.dev/ --live
```

`--live` works only with the `scenario` verb, the exact URL `https://sprockt.dev/`, and scenarios that set `live: true` (`starter-dev-server` and `github-real-repo`). Any other URL, verb, or scenario is rejected.

Switch engines with `--engine chromium|webkit|firefox`, viewports with `--viewport desktop|phone|WxH`, and color schemes with `--scheme light|dark`. Pass `--headed` for a real GPU window instead of headless capture.

## Doctor

Run doctor first whenever starting a verification pass or after a failed drive:

```bash
bun run agent:browser look --doctor
```

Doctor passes only when:

- navigation returns HTTP 2xx and mounts a known Sprockt view (`landing-page`, `workbench`, or `import-page`),
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
bun run agent:browser look [--doctor] [--url URL] [--viewport desktop|phone|WxH] [--scheme light|dark] [--engine chromium|webkit|firefox] [--selector CSS] [--headed]
bun run agent:browser scenario <name> [--url URL] [--live] [--viewport desktop|phone|WxH] [--scheme light|dark] [--engine chromium|webkit|firefox] [--starter ID] [--headed]
```

Built-in scenarios live in `scripts/agent/scenarios/`:

- `landing-desktop-mobile` (`read-only`): checks the landing page at `1440x900` and `390x844` in light and dark modes, zero overflow, and all 7 starter cards present.
- `starter-dev-server` (`live`-capable): opens a starter (`--starter vite-react` by default), asserts first-open auto-start without clicking **Start dev server** (on phone, waits for `preview-task` to reach `running` and `preview-port` to attach before tapping **Preview**), writes `cold-boot.json`, and captures `01-auto-started-preview.png`. For `vite-react`, it clicks the counter, clicks preview reload (`wb-preview-reload`) to prove the counter resets while the server stays up, and on desktop edits `src/App.tsx` to verify React HMR updates the heading without resetting the counter and leaves zero `lsp-plugin-error` ranges (`02-hmr-updated.png`).
- `github-real-repo` (`live`-capable): imports an immutable public GitHub repository from its real archive, runs `bun install`, waits for the preview to render, and captures evidence. Supports `--url https://sprockt.dev/ --live`.
- `workbench-tabs-and-explorer`: filters the file tree, opens a second tab, creates and edits a new file, and opens the command palette.
- `mobile-workbench`: runs at `390x844` with real touch input (`hasTouch: true`, `.tap()`), verifies tab switching never focuses the editor (keeping the soft keyboard closed), checks that an explicit editor tap focuses it, and confirms that toggling Light to Dark while the Terminal pane is hidden syncs Ghostty to a dark theme on reveal.
- `github-import-and-share`: checks landing repo input validation and round-trips a `/s#share=...` snapshot into a fresh isolated browser context.

All stable selectors live in `scripts/agent/selectors.ts`. When adding coverage for a new view or control, add selectors there and add a scenario under `scripts/agent/scenarios/`.

## Evidence

Every run creates `<OS temp>/sprockt-evidence/<stamp>-<verb>-<label>/` (override with `SPROCKT_EVIDENCE_ROOT` or `--evidence-root`) containing:

- `summary.md`: concise PASS/FAIL report printed to stdout
- `01-*.png`, `02-*.png`, ...: viewport and step screenshots
- `cold-boot.json`: milestone timings (`workspaceOpenedMs`, `workbenchReadyMs`, `serverListeningMs`, `previewRenderedMs`) and resource timings for `.wasm`, `/api/github/`, and boot/worker assets (written by `starter-dev-server` and cold-boot scenarios)
- `observed.json`: `pageErrors`, `consoleErrors`, `consoleWarnings`, `failedRequests`, `badResponses`
- `layout.json`: viewport dimensions, `overflowX`, `crossOriginIsolated`, theme state, visible alerts, broken images, iframe geometry
- `server.log`: throwaway `vite preview` stdout and stderr (for local runs)

Proof standards:

- Drive the real user path (wait for first-open auto-start on fresh starters and imports, reload the preview, tap real tabs, edit real files). Do not trust "it compiles" or a workbench-open-only check.
- Remember the reload boundary: starter and import plans run once per workspace in `WorkspaceSession` (`pendingImport` is cleared when consumed). Reloading the workspace tab requires clicking **Start dev server** manually, while clicking preview reload (`wb-preview-reload`) reloads the iframe and keeps the server running.
- Open captured screenshots with `read_file` and inspect them visually. A screenshot nobody looked at is not evidence.
- When testing on iOS Simulator (iPhone Safari), use the T3 `device_*` tools and `agent-device` CLI against the live preview URL in addition to Playwright WebKit.

## Cleanup

The CLI closes its browser and stops only the throwaway `vite preview` child it spawned. It never calls `pkill` and never deletes evidence directories. Evidence stays on disk so failures and screenshots can be inspected afterward.

## Helpers

- `scripts/agent/selectors.ts`: canonical `data-testid` and `aria-label` selectors for every view.
- `scripts/agent/args.ts`: viewport presets (`desktop` = `1440x900`, `phone` = `390x844` touch), engine selection, `--live` gating, and URL handling.
- `scripts/agent/boot-timing.ts`: cold-boot milestone timer and resource timing collector for `cold-boot.json`.
- `scripts/agent/server.ts`: free-port throwaway `vite preview` lifecycle.
- `scripts/agent/evidence.ts`: screenshot capture, layout snapshot, and error observer.
- `scripts/iphone-smoke.ts`: existing real iPhone simulator smoke script.

## Feature map

[`features/README.md`](features/README.md) indexes Sprockt's 8 user-facing areas. Check every feature file affected by your change before calling work done.
