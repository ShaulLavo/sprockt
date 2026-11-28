# Ghostty terminal

Interactive WASI shell (`bash-web` + `bun-wasm` 1.4.5) rendered on a WebGPU/WebGL canvas by `ghostty-webgpu` (`src/terminal/`).

## Sub-features

- Multiple terminal tabs (`terminal-tab`, `new-terminal`), split terminal toggle, rename, close, and collapsible bottom panel (`terminal-panel`).
- Live shell readiness indicator (`terminal-state`: `ready` once prompt is interactive).
- Reactive Light/Dark theme synchronization (`src/terminal/waffle-adapter.ts`, `src/terminal/pane/TerminalPanel.tsx`), including when the terminal pane is hidden or mid-boot.
- Touch helper key toolbar (`term-keys`) on phone viewports (Esc, Tab, Ctrl, arrows).

## How to get to it (user POV)

On desktop, the Terminal sits in the bottom panel. On phone, tap **Terminal** in `pane-switcher`. Wait for `terminal-state` to report `ready`, click/tap `.terminal-host`, and type commands such as `bun --version` or `ls`.

## Driving it with agent:browser

```bash
bun run agent:browser scenario mobile-workbench
bun run agent:browser scenario mobile-workbench --engine webkit
```

The `mobile-workbench` scenario toggles Light → Dark while the Terminal pane is hidden (`Code` tab active), switches to `Terminal`, waits for `ready`, samples the rendered background luminance, and saves `03-mobile-terminal-dark-synced.png`.

## Gotchas

- Never mount a CSS color probe inside a `display: none` ancestor (`TerminalPanel` hides inactive mobile panes with `display: none`). WebKit/iOS Safari skips style recalc inside `display: none` subtrees and returns stale light-mode `light-dark()` colors. `readTerminalColors` mounts a fixed non-`display: none` probe on `document.body` with explicit `colorScheme`.
- `TerminalView` must re-sync appearance both right after async `startTerminal()` finishes (catching mid-boot theme switches) and whenever `visible` flips to `true`.
- Terminal output draws on a `<canvas>`; programmatic assertions read text via `globalThis.sprockt?.terminalLines()` and verify visual theme via screenshots + computed/sampled colors.
