# Editor, tabs, and TypeScript LSP

Singapore code editor (`src/editor/`) with multi-tab strip, syntax highlighting, autosave/recovery drafts, Quick Open / Command Palette, in-page project search, and `tsrs-lsp` TypeScript diagnostics.

## Sub-features

- Multi-tab strip (`editor-tabs`, `editor-tab`) with dirty dot (`editor-dirty`), drag reorder, close/close-others/close-all with staged unsaved-changes confirmation (`unsaved-dialog`).
- Syntax highlighting (lazy grammars, live light/dark theme sync), breadcrumbs (`editor-file`), status bar save state (`save-state`), and external-change conflict bar (`editor-conflict`).
- Quick Open (`Mod+P`) and Command Palette (`Mod+Shift+P` or `Search files and commands` button).
- TypeScript IntelliSense powered by `tsrs-lsp.wasm` (`src/lsp/project.ts`, `src/lsp/typescript.ts`), gated on direct `package.json` dependency installation so fresh starters open without false-alarm squiggles.

## How to get to it (user POV)

Open any workspace; the entry file opens automatically in the editor pane. Click tabs in `editor-tabs` to switch files, edit text (autosaves to IndexedDB by default, or `Mod+S` when autosave is off), and press `Mod+Shift+P` for commands.

## Driving it with agent:browser

```bash
bun run agent:browser scenario starter-dev-server
bun run agent:browser scenario workbench-tabs-and-explorer
```

Verify:

- Before `node_modules` is installed, `CSS.highlights` contains zero `lsp-plugin-error` ranges and the status bar shows a quiet `Install deps for TS` indicator instead of a wall of red squiggles.
- After **Start dev server** (`bun install`) finishes, `Install deps for TS` clears and `CSS.highlights` remains at zero `lsp-plugin-error` ranges. Positive LSP diagnostic, hover, and completion checks live in `e2e/lsp.spec.ts`.

## Gotchas

- `ProjectReadyWaiter` checks every direct package in `dependencies` and `devDependencies` (`node_modules/<pkg>/package.json`). A partial install must keep waiting until all declared packages exist.
- On touch/coarse-pointer/mobile viewports (`<= 768px`), clicking or tapping a tab must NEVER call `editor.focus()` (which pops up the iOS/Android soft keyboard). Keyboard `Enter` activation on hybrid touch laptops still focuses the editor.
- Always check `e2e/lsp.spec.ts` and `e2e/editor.spec.ts` when changing `src/lsp/` or `src/editor/focus-policy.ts`.
