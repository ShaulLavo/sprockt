// The workbench as it looks with the Vite + React starter open, drawn in plain markup so the
// landing page loads no editor, terminal or runtime code. It shows the template's real source
// and the real output of its install and dev commands. Wide, it is the desktop frame; under
// 720px of its own width (a phone, or the narrow tab beside the browser list) it is the phone
// frame, one pane at a time. Every copy on the page shares one Demo, as tabs share a workspace.
import { createSignal, For, Show, untrack } from "solid-js";
import { DEMO_READY, type Demo } from "./demo";
import { Icon } from "./icons";
import { APP_TSX_LINES, type SourceLine } from "./starter-source";

export type PhonePane = "files" | "code" | "preview" | "terminal";

/** The editor's current line, counted from 1: the heading. The keyboard is in the terminal. */
const CARET_LINE = 9;

function lineLength(line: SourceLine): number {
  return line.tokens.reduce((length, token) => length + token[1].length, line.indent);
}

/** The column after the current line's last character, as the status bar counts it. */
const CARET_COLUMN = lineLength(APP_TSX_LINES[CARET_LINE - 1]!) + 1;

interface TreeRow {
  readonly name: string;
  readonly depth: number;
  readonly kind: "dir" | "dir-open" | "tsx" | "ts" | "css" | "html" | "json" | "lock";
  readonly dim?: boolean;
  readonly selected?: boolean;
}

const TREE: readonly TreeRow[] = [
  { name: "node_modules", depth: 0, kind: "dir", dim: true },
  { name: "src", depth: 0, kind: "dir-open" },
  { name: "App.css", depth: 1, kind: "css" },
  { name: "App.tsx", depth: 1, kind: "tsx", selected: true },
  { name: "main.tsx", depth: 1, kind: "tsx" },
  { name: "bun.lock", depth: 0, kind: "lock" },
  { name: "index.html", depth: 0, kind: "html" },
  { name: "package.json", depth: 0, kind: "json" },
  { name: "tsconfig.json", depth: 0, kind: "json" },
  { name: "vite.config.ts", depth: 0, kind: "ts" },
];

const FILE_MARK: Readonly<Record<TreeRow["kind"], string>> = {
  dir: "",
  "dir-open": "",
  tsx: "TX",
  ts: "TS",
  css: "#",
  html: "<>",
  json: "{}",
  lock: "··",
};

const PANES: readonly { pane: PhonePane; label: string; icon: "files" | "code" | "globe" | "terminal" }[] = [
  { pane: "files", label: "Files", icon: "files" },
  { pane: "code", label: "Code", icon: "code" },
  { pane: "preview", label: "Preview", icon: "globe" },
  { pane: "terminal", label: "Terminal", icon: "terminal" },
];

/** The keys the real terminal adds on a phone (src/terminal/TerminalKeys.tsx). */
const SOFT_KEYS = ["esc", "tab", "ctrl", "↑", "↓", "←", "→", "|", "~", "/", "-"] as const;

function FileMark(props: { kind: TreeRow["kind"] }) {
  return (
    <Show when={FILE_MARK[props.kind]} fallback={<Icon name="folder" class="lp-wb-ft lp-ft-dir" />}>
      {(mark) => <span class={`lp-wb-ft lp-ft-${props.kind}`}>{mark()}</span>}
    </Show>
  );
}

/** A prompt, with its command once that step of the boot has arrived. */
function Prompt(props: { command: string; entered: boolean }) {
  return (
    <span class="lp-wb-tline">
      <span class="a-path">~/vite-react</span> <span class="a-prompt">$</span>{" "}
      <Show when={props.entered}>{props.command}</Show>
    </span>
  );
}

export interface WorkbenchPreviewProps {
  readonly demo: Demo;
  /** The pane the phone frame opens on. */
  readonly pane: PhonePane;
  /** What the frame is, for assistive technology. */
  readonly label: string;
}

export function WorkbenchPreview(props: WorkbenchPreviewProps) {
  // The pane a frame opens on is read once: after that the visitor picks.
  const [pane, setPane] = createSignal<PhonePane>(untrack(() => props.pane));
  const step = () => props.demo.step();

  return (
    <div class="lp-wb-frame">
      <div
        class="lp-wb"
        data-ui="workbench"
        role="group"
        aria-label={props.label}
        data-phone-pane={pane()}
        data-step={step()}
      >
        <div class="lp-wb-titlebar">
          <span class="lp-wb-brand">
            <Icon name="logo" class="lp-wb-mark" />
            <span class="lp-wb-brand-word">Sprockt</span>
          </span>
          <span class="lp-wb-crumb">vite-react</span>
          <span class="lp-wb-palette" aria-hidden="true">
            <Icon name="search" />
            <span>Search files and commands</span>
            <kbd>⌘K</kbd>
          </span>
          <span class="lp-wb-titlebar-right">
            <Show when={props.demo.ready()}>
              <span class="lp-wb-run">
                <span class="lp-wb-lamp" aria-hidden="true" />
                dev :5173
              </span>
            </Show>
            <span class="lp-wb-more" aria-hidden="true">
              <Icon name="more" />
            </span>
          </span>
        </div>

        {/* All three panes are open; the lamp marks the one that has the keyboard. */}
        <div class="lp-wb-activity" aria-hidden="true">
          <span class="lp-wb-act is-open">
            <Icon name="files" />
          </span>
          <span class="lp-wb-act is-open">
            <Icon name="globe" />
          </span>
          <span class="lp-wb-act is-open is-focus">
            <Icon name="terminal" />
          </span>
        </div>

        <div class="lp-wb-pane lp-wb-explorer" aria-hidden="true">
          <div class="lp-wb-head">Files</div>
          <ul class="lp-wb-tree">
            <For each={TREE}>
              {(row) => (
                <li
                  class="lp-wb-row"
                  classList={{ "is-dim": row.dim, "is-selected": row.selected }}
                  style={{ "--depth": row.depth }}
                >
                  <Show
                    when={row.kind === "dir" || row.kind === "dir-open"}
                    fallback={<span class="lp-wb-chev" />}
                  >
                    <Icon name={row.kind === "dir" ? "chev-r" : "chev-d"} class="lp-wb-chev" />
                  </Show>
                  <FileMark kind={row.kind} />
                  <span>{row.name}</span>
                </li>
              )}
            </For>
          </ul>
        </div>

        <div class="lp-wb-pane lp-wb-editor" aria-hidden="true">
          <div class="lp-wb-strip">
            <span class="lp-wb-tooth is-active">
              <FileMark kind="tsx" />
              App.tsx
              <Icon name="x" class="lp-wb-tooth-x" />
            </span>
            <span class="lp-wb-tooth">
              <FileMark kind="css" />
              App.css
            </span>
            <span class="lp-wb-tooth">
              <FileMark kind="ts" />
              vite.config.ts
            </span>
          </div>
          <ol class="lp-wb-code">
            <For each={APP_TSX_LINES}>
              {(line, index) => (
                <li classList={{ "is-current": index() + 1 === CARET_LINE }}>
                  <span class="lp-wb-ln">{index() + 1}</span>
                  <code style={{ "--indent": line.indent }}>
                    {" ".repeat(line.indent)}
                    <For each={line.tokens}>
                      {(token) => (
                        <Show when={token[0]} fallback={token[1]}>
                          <span class={token[0]}>{token[1]}</span>
                        </Show>
                      )}
                    </For>
                  </code>
                </li>
              )}
            </For>
          </ol>
        </div>

        <div class="lp-wb-pane lp-wb-preview">
          <div class="lp-wb-head" aria-hidden="true">
            Preview
            <span class="lp-wb-url">
              <Icon name="reload" />
              <span>127.0.0.1:5173</span>
              <Icon name="external" />
            </span>
          </div>
          <Show
            when={props.demo.ready()}
            fallback={
              <p class="lp-wb-empty">
                {step() >= DEMO_READY - 1
                  ? "Starting the dev server. The preview will load once a port opens."
                  : "No dev server is running yet. Start one in the terminal to preview it here."}
              </p>
            }
          >
            <div class="lp-wb-app">
              <p class="lp-wb-app-title">Hello from bun.wasm</p>
              <p class="lp-wb-app-tagline">
                Vite serves this React app through Bun, running in your browser.
              </p>
              <button type="button" class="lp-wb-app-counter" onClick={() => props.demo.bump()}>
                count is {props.demo.count()}
              </button>
              <p class="lp-wb-app-hint">
                Edit <code>src/App.tsx</code> and the page updates without losing the count.
              </p>
            </div>
          </Show>
        </div>

        <div class="lp-wb-pane lp-wb-terminal" aria-hidden="true">
          <div class="lp-wb-strip">
            <span class="lp-wb-tooth is-active is-lit">
              <Show when={props.demo.ready()} fallback={<Icon name="terminal" />}>
                <span class="lp-wb-lamp" />
              </Show>
              bash
              <Icon name="x" class="lp-wb-tooth-x" />
            </span>
            <span class="lp-wb-strip-add">
              <Icon name="plus" />
            </span>
            <span class="lp-wb-strip-actions">
              <Icon name="split" />
              <Icon name="trash" />
              <Icon name="chev-d" />
            </span>
          </div>
          <div class="lp-wb-term">
            <pre>
              <Prompt command="bun install" entered={step() >= 1} />
              <Show when={step() >= 2}>
                <span class="lp-wb-tline">
                  <span class="a-bold">bun install</span> <span class="a-dim">v1.4.4</span>
                </span>
                <span class="lp-wb-tline"> </span>
                <span class="lp-wb-tline">
                  <span class="a-ok">+</span> @types/react<span class="a-dim">@19.3.3</span>
                </span>
                <span class="lp-wb-tline">
                  <span class="a-ok">+</span> @types/react-dom<span class="a-dim">@19.3.0</span>
                </span>
                <span class="lp-wb-tline">
                  <span class="a-ok">+</span> @vitejs/plugin-react<span class="a-dim">@6.1.2</span>
                </span>
                <span class="lp-wb-tline">
                  <span class="a-ok">+</span> vite<span class="a-dim">@8.3.5</span>
                </span>
                <span class="lp-wb-tline">
                  <span class="a-ok">+</span> react<span class="a-dim">@19.3.1</span>
                </span>
                <span class="lp-wb-tline">
                  <span class="a-ok">+</span> react-dom<span class="a-dim">@19.3.1</span>
                </span>
                <span class="lp-wb-tline"> </span>
                <Prompt command="bun run dev" entered={step() >= 3} />
              </Show>
              <Show when={props.demo.ready()}>
                {/* The script's echo is wider than a phone's terminal; the phone frame leaves it out. */}
                <span class="lp-wb-tline is-wide">
                  <span class="a-dim">$ vite --host 127.0.0.1 --port 5173 --strictPort</span>
                </span>
                <span class="lp-wb-tline"> </span>
                <span class="lp-wb-tline">
                  {"  "}
                  <span class="a-ok a-bold">VITE</span> <span class="a-ok">v8.3.5</span>
                  {"  "}
                  <span class="a-dim">ready</span>
                </span>
                <span class="lp-wb-tline"> </span>
                <span class="lp-wb-tline">
                  {"  "}
                  <span class="a-ok">➜</span>
                  {"  "}
                  <span class="a-bold">Local</span>:{"   "}
                  <span class="a-link">http://127.0.0.1:5173/</span>
                </span>
              </Show>
              <span class="lp-wb-tline">
                <span class="lp-wb-tcur" />
              </span>
            </pre>
          </div>
          <div class="lp-wb-keys">
            <div class="lp-wb-keys-row">
              <For each={SOFT_KEYS}>{(key) => <span>{key}</span>}</For>
            </div>
          </div>
        </div>

        <div class="lp-wb-status" aria-hidden="true">
          <span>
            <Icon name="check" />
            saved
          </span>
          <span class="lp-wb-status-end">
            Ln {CARET_LINE}, Col {CARET_COLUMN}
          </span>
          <span>TypeScript JSX</span>
        </div>

        <div class="lp-wb-switcher" role="tablist" aria-label="Panes">
          <For each={PANES}>
            {(item) => (
              <button
                type="button"
                role="tab"
                aria-selected={pane() === item.pane}
                onClick={() => setPane(item.pane)}
              >
                <Icon name={item.icon} />
                <span>{item.label}</span>
              </button>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
