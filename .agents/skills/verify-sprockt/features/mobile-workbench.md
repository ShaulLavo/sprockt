# Mobile workbench

Responsive phone layout (`<= 768px`, tested at `390×844` with real touch input and real iPhone Safari).

## Sub-features

- Single-pane viewport switched via the bottom `pane-switcher` (`Files`, `Code`, `Preview`, `Terminal`) with an unsaved indicator dot on `Code`.
- Compact title bar with workspace menu (`phone-menu` → Save, Save all, Autosave toggle, Switch workspace, Share, Download, and Light/Dark `ThemeToggle`).
- Touch-safe editor tab bar: tapping a tab switches files without focusing the editor or opening the on-screen keyboard; only an explicit tap directly on `.editor-host` focuses the editor.
- Phone terminal helper key strip (`term-keys`) and soft-wrapped editor lines.

## How to get to it (user POV)

Open any workspace on a phone (`390×844` viewport or iOS Safari). Switch between Files, Code, Preview, and Terminal using the bottom bar; open the `…` button (`phone-menu`) to save or switch Light/Dark theme.

## Driving it with agent:browser

```bash
bun run agent:browser scenario mobile-workbench
bun run agent:browser scenario mobile-workbench --engine webkit
```

Inspect all three screenshots (`01-mobile-tab-switch-no-focus.png`, `02-mobile-editor-explicit-focus.png`, `03-mobile-terminal-dark-synced.png`) and `layout.json` (`overflowX === 0`, `focusedAfterTabTap === false`, `focusedAfterEditorTap === true`, dark terminal luminance `< 60`).

## Gotchas

- Always test mobile interactions with real touch (`hasTouch: true` + `.tap()`), not desktop `.click()`. Desktop mouse clicks follow a different focus policy than touch taps (`src/editor/focus-policy.ts`).
- Before deploying a preview for the owner's phone, also verify on a real iOS Simulator via T3 `device_open` + `agent-device` + `device_screenshot` to catch real Mobile Safari keyboard, viewport, and WASI memory issues (such as Rolldown's 4 GiB reservation limit).
