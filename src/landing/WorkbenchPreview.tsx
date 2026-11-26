// Live, interactive workbench showcase for the landing page.
// Blends Sheet and Biro's crisp true-scale chrome with Precision Sheet's multicolor tabs and
// lively scripted sequence (typing, Bun 1.4.5 install, Vite dev server, TypeScript hover, save
// tick and HMR flash), while keeping zero runtime/Waffle imports on `/`.
import { createSignal, createUniqueId, For, Show, untrack } from "solid-js";
import { fileTabTone, type TabTone } from "../ui/tab-colors";
import {
  DEMO_DEV_TYPING,
  DEMO_HOVER_EDIT,
  DEMO_INSTALL_DONE,
  DEMO_INSTALL_TYPING,
  DEMO_READY,
  DEMO_SAVED_HMR,
  type Demo,
  type DemoFileId,
  type DemoTerminalId,
} from "./demo";
import { Icon } from "./icons";
import { APP_TSX_LINES, DEMO_FILE_LINES, type SourceLine } from "./starter-source";

export type PhonePane = "files" | "code" | "preview" | "terminal";

/** The editor's active line in App.tsx (line 5: useState). */
const CARET_LINE = 5;

function lineLength(line: SourceLine): number {
  return line.tokens.reduce((length, token) => length + token[1].length, line.indent);
}

const CARET_COLUMN = lineLength(APP_TSX_LINES[CARET_LINE - 1]!) + 1;

interface TreeRow {
  readonly name: string;
  readonly depth: number;
  readonly kind: "dir" | "dir-open" | "tsx" | "ts" | "css" | "html" | "json" | "lock";
  readonly dim?: boolean;
  readonly fileId?: DemoFileId;
}

const TREE: readonly TreeRow[] = [
  { name: "node_modules", depth: 0, kind: "dir", dim: true },
  { name: "src", depth: 0, kind: "dir-open" },
  { name: "App.css", depth: 1, kind: "css", fileId: "App.css" },
  { name: "App.tsx", depth: 1, kind: "tsx", fileId: "App.tsx" },
  { name: "main.tsx", depth: 1, kind: "tsx" },
  { name: "bun.lock", depth: 0, kind: "lock" },
  { name: "index.html", depth: 0, kind: "html", fileId: "index.html" },
  { name: "package.json", depth: 0, kind: "json", fileId: "package.json" },
  { name: "tsconfig.json", depth: 0, kind: "json" },
  { name: "vite.config.ts", depth: 0, kind: "ts" },
];

const EDITOR_TABS: readonly { id: DemoFileId; kind: TreeRow["kind"]; path: string; lang: string }[] = [
  { id: "App.tsx", kind: "tsx", path: "src/App.tsx", lang: "TypeScript JSX" },
  { id: "App.css", kind: "css", path: "src/App.css", lang: "CSS" },
  { id: "package.json", kind: "json", path: "package.json", lang: "JSON" },
  { id: "index.html", kind: "html", path: "index.html", lang: "HTML" },
];

const TERM_TABS: readonly { id: DemoTerminalId; label: string; tone: TabTone }[] = [
  { id: "bash", label: "bash", tone: "shell" },
  { id: "dev", label: "dev :5173", tone: "server" },
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

const SOFT_KEYS = ["esc", "tab", "ctrl", "^C", "↑", "↓", "←", "→", "|", "~", "/", "-"] as const;

function nextTabIndex(key: string, current: number, length: number): number | undefined {
  if (length <= 0) return undefined;
  if (key === "ArrowRight" || key === "ArrowDown") return (current + 1) % length;
  if (key === "ArrowLeft" || key === "ArrowUp") return (current - 1 + length) % length;
  if (key === "Home") return 0;
  if (key === "End") return length - 1;
  return undefined;
}

function handleTabListKeyDown<T>(
  event: KeyboardEvent & { currentTarget: HTMLButtonElement },
  items: readonly T[],
  currentIndex: number,
  onSelect: (item: T) => void,
): void {
  const next = nextTabIndex(event.key, currentIndex, items.length);
  if (next === undefined) return;
  event.preventDefault();
  onSelect(items[next]!);
  const tablist = event.currentTarget.closest('[role="tablist"]');
  const tabs = tablist?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
  tabs?.[next]?.focus();
}

function FileMark(props: { kind: TreeRow["kind"] }) {
  return (
    <Show when={FILE_MARK[props.kind]} fallback={<Icon name="folder" class="lp-wb-ft lp-ft-dir" />}>
      {(mark) => (
        <span class={`lp-wb-ft lp-ft-${props.kind}`} aria-hidden="true">
          {mark()}
        </span>
      )}
    </Show>
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
  const [pane, setPane] = createSignal<PhonePane>(untrack(() => props.pane));
  const step = () => props.demo.step();
  const activeTabMeta = () =>
    EDITOR_TABS.find((tab) => tab.id === props.demo.activeFile()) ?? EDITOR_TABS[0]!;
  const lines = () => DEMO_FILE_LINES[props.demo.activeFile()];

  const uid = createUniqueId();
  const tabId = (name: PhonePane) => `${uid}-tab-${name}`;
  const panelId = (name: PhonePane) => `${uid}-panel-${name}`;
  const panel = (name: PhonePane) =>
    ({ id: panelId(name), role: "tabpanel", "aria-labelledby": tabId(name) }) as const;

  const fileTabId = (id: DemoFileId) => `${uid}-file-tab-${id}`;
  const filePanelId = `${uid}-file-panel`;
  const termTabId = (id: DemoTerminalId) => `${uid}-term-tab-${id}`;
  const termPanelId = `${uid}-term-panel`;

  function openDemoFile(id: DemoFileId): void {
    props.demo.setActiveFile(id);
    setPane("code");
  }

  return (
    <div class="lp-wb-frame">
      <div
        class="lp-wb"
        data-ui="workbench"
        role="group"
        aria-label={props.label}
        data-phone-pane={pane()}
        data-step={step()}
        data-playing={props.demo.playing() ? "true" : "false"}
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
            <Show when={!props.demo.reducedMotion()}>
              <button
                type="button"
                class="lp-wb-replay"
                aria-label={props.demo.playing() ? "Pause demo" : "Replay demo"}
                title={props.demo.playing() ? "Pause demo" : "Replay demo"}
                onClick={() => (props.demo.playing() ? props.demo.pause() : props.demo.replay())}
              >
                <Icon name={props.demo.playing() ? "stop" : "reload"} />
              </button>
            </Show>
          </span>
        </div>

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

        <div class="lp-wb-pane lp-wb-explorer" {...panel("files")}>
          <div class="lp-wb-head" aria-hidden="true">
            Explorer
            <span class="lp-wb-head-dim">vite-react</span>
          </div>
          <ul class="lp-wb-tree">
            <For each={TREE}>
              {(row) => {
                const selected = () => row.fileId !== undefined && props.demo.activeFile() === row.fileId;
                return (
                  <li
                    class="lp-wb-row"
                    classList={{
                      "is-dim": row.dim,
                      "is-selected": selected(),
                      "is-clickable": row.fileId !== undefined,
                    }}
                    data-tab-tone={row.fileId ? fileTabTone(row.name) : undefined}
                    style={{ "--depth": row.depth }}
                  >
                    <Show
                      when={row.fileId}
                      fallback={
                        <>
                          <Show
                            when={row.kind === "dir" || row.kind === "dir-open"}
                            fallback={<span class="lp-wb-chev" aria-hidden="true" />}
                          >
                            <Icon name={row.kind === "dir" ? "chev-r" : "chev-d"} class="lp-wb-chev" />
                          </Show>
                          <FileMark kind={row.kind} />
                          <span>{row.name}</span>
                        </>
                      }
                    >
                      {(fileId) => (
                        <button
                          type="button"
                          class="lp-wb-row-btn"
                          aria-current={selected() ? "true" : undefined}
                          onClick={() => openDemoFile(fileId())}
                        >
                          <span class="lp-wb-chev" aria-hidden="true" />
                          <FileMark kind={row.kind} />
                          <span>{row.name}</span>
                        </button>
                      )}
                    </Show>
                  </li>
                );
              }}
            </For>
          </ul>
        </div>

        <div class="lp-wb-pane lp-wb-editor" {...panel("code")}>
          <div class="lp-wb-strip" role="tablist" aria-label="Open files">
            <For each={EDITOR_TABS}>
              {(tab, index) => {
                const isActive = () => props.demo.activeFile() === tab.id;
                return (
                  <button
                    type="button"
                    role="tab"
                    id={fileTabId(tab.id)}
                    class="lp-wb-tab"
                    classList={{ "is-active": isActive() }}
                    aria-selected={isActive()}
                    aria-controls={filePanelId}
                    tabindex={isActive() ? 0 : -1}
                    data-tab-tone={fileTabTone(tab.id)}
                    onClick={() => props.demo.setActiveFile(tab.id)}
                    onKeyDown={(event) =>
                      handleTabListKeyDown(event, EDITOR_TABS, index(), (next) =>
                        props.demo.setActiveFile(next.id),
                      )
                    }
                  >
                    <FileMark kind={tab.kind} />
                    <span>{tab.id}</span>
                  </button>
                );
              }}
            </For>
          </div>
          <div
            id={filePanelId}
            class="lp-wb-code-wrap"
            role="tabpanel"
            aria-labelledby={fileTabId(props.demo.activeFile())}
          >
            <ol class="lp-wb-code">
              <For each={lines()}>
                {(line, index) => {
                  const isCurrent = () => props.demo.activeFile() === "App.tsx" && index() + 1 === CARET_LINE;
                  return (
                    <li classList={{ "is-current": isCurrent() }}>
                      <span class="lp-wb-ln" aria-hidden="true">
                        {index() + 1}
                      </span>
                      <code style={{ "--indent": line.indent }}>
                        {" ".repeat(line.indent)}
                        <For each={line.tokens}>
                          {(token) => (
                            <Show when={token[0]} fallback={token[1]}>
                              <span
                                class={token[0]}
                                classList={{
                                  "lp-wb-hov":
                                    isCurrent() && step() >= DEMO_HOVER_EDIT && token[1] === "useState",
                                }}
                              >
                                {token[1]}
                              </span>
                            </Show>
                          )}
                        </For>
                        <Show when={isCurrent()}>
                          <span class="lp-wb-caret" aria-hidden="true" />
                        </Show>
                      </code>
                    </li>
                  );
                }}
              </For>
            </ol>
            <Show when={props.demo.activeFile() === "App.tsx" && step() === DEMO_HOVER_EDIT}>
              <div class="lp-wb-hover" aria-hidden="true">
                <div class="lp-wb-hover-sig">
                  <span class="sk">function</span> <span class="sf">useState</span>&lt;S&gt;(initialState: S |
                  (() =&gt; S)): [S, Dispatch&lt;SetStateAction&lt;S&gt;&gt;]
                </div>
                <div class="lp-wb-hover-meta">
                  <span>tsrs · TypeScript LSP</span>
                  <span class="lp-wb-hover-ok">0 errors</span>
                </div>
              </div>
            </Show>
          </div>
        </div>

        <div class="lp-wb-pane lp-wb-preview" {...panel("preview")}>
          <div class="lp-wb-head" aria-hidden="true">
            <span class="lp-wb-url">
              <span class="lp-wb-url-dot" classList={{ "is-live": props.demo.ready() }} />
              <span class="lp-wb-url-text">vite-react-5173-pv.sprockt.dev</span>
              <Icon name="external" />
            </span>
          </div>
          <Show
            when={props.demo.ready()}
            fallback={
              <div class="lp-wb-empty">
                <p>
                  {step() >= DEMO_DEV_TYPING
                    ? "Starting Vite dev server on port 5173..."
                    : "Installing packages in this browser tab..."}
                </p>
              </div>
            }
          >
            <div class="lp-wb-app" classList={{ "is-hmr": props.demo.hmrFlash() }}>
              <span class="lp-wb-app-badge">
                <Show when={step() >= DEMO_SAVED_HMR} fallback="Port 5173 · Live">
                  HMR updated · src/App.tsx
                </Show>
              </span>
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

        <div class="lp-wb-pane lp-wb-terminal" {...panel("terminal")}>
          <div class="lp-wb-strip" role="tablist" aria-label="Terminal tabs">
            <For each={TERM_TABS}>
              {(tab, index) => {
                const isActive = () => props.demo.activeTerm() === tab.id;
                return (
                  <button
                    type="button"
                    role="tab"
                    id={termTabId(tab.id)}
                    class="lp-wb-tab"
                    classList={{ "is-active": isActive() }}
                    aria-selected={isActive()}
                    aria-controls={termPanelId}
                    tabindex={isActive() ? 0 : -1}
                    data-tab-tone={tab.tone}
                    onClick={() => props.demo.setActiveTerm(tab.id)}
                    onKeyDown={(event) =>
                      handleTabListKeyDown(event, TERM_TABS, index(), (next) =>
                        props.demo.setActiveTerm(next.id),
                      )
                    }
                  >
                    <span class="lp-wb-term-dot" aria-hidden="true" />
                    <span>{tab.label}</span>
                  </button>
                );
              }}
            </For>
            <span class="lp-wb-strip-meta" aria-hidden="true">
              Ghostty WebGPU
            </span>
          </div>
          <div
            id={termPanelId}
            class="lp-wb-term"
            role="tabpanel"
            aria-labelledby={termTabId(props.demo.activeTerm())}
          >
            <Show
              when={props.demo.activeTerm() === "bash"}
              fallback={
                <pre>
                  <span class="lp-wb-tline">
                    <span class="a-dim">$ vite --host 127.0.0.1 --port 5173 --strictPort</span>
                  </span>
                  <span class="lp-wb-tline">
                    {"  "}
                    <span class="a-ok a-bold">VITE</span> <span class="a-ok">v8.3.5</span>{" "}
                    <span class="a-dim">ready</span>
                  </span>
                  <span class="lp-wb-tline">
                    {"  "}
                    <span class="a-ok">➜</span> <span class="a-bold">Local</span>:{" "}
                    <span class="a-link">http://127.0.0.1:5173/</span>
                  </span>
                  <Show when={step() >= DEMO_SAVED_HMR}>
                    <span class="lp-wb-tline">
                      <span class="a-ok">✓</span> hmr update <span class="a-path">/src/App.tsx</span>
                    </span>
                  </Show>
                </pre>
              }
            >
              <pre>
                <span class="lp-wb-tline">
                  <span class="a-path">~/vite-react</span> <span class="a-prompt">$</span>{" "}
                  {step() >= DEMO_INSTALL_TYPING ? props.demo.installTyped() : ""}
                  <Show when={step() < DEMO_INSTALL_DONE}>
                    <span class="lp-wb-tcur" aria-hidden="true" />
                  </Show>
                </span>
                <Show when={step() >= DEMO_INSTALL_DONE}>
                  <span class="lp-wb-tline">
                    <span class="a-bold">bun install</span> <span class="a-dim">v1.4.5</span>
                  </span>
                  <span class="lp-wb-tline">
                    <span class="a-ok">+</span> react<span class="a-dim">@19.3.1</span>{" "}
                    <span class="a-ok">+</span> vite<span class="a-dim">@8.3.5</span>
                  </span>
                  <span class="lp-wb-tline">
                    <span class="a-path">~/vite-react</span> <span class="a-prompt">$</span>{" "}
                    {step() >= DEMO_DEV_TYPING ? props.demo.devTyped() : ""}
                    <Show when={step() >= DEMO_INSTALL_DONE && step() < DEMO_READY}>
                      <span class="lp-wb-tcur" aria-hidden="true" />
                    </Show>
                  </span>
                </Show>
                <Show when={props.demo.ready()}>
                  <span class="lp-wb-tline">
                    {"  "}
                    <span class="a-ok a-bold">VITE</span> <span class="a-ok">v8.3.5</span>{" "}
                    <span class="a-dim">ready</span> <span class="a-link">http://127.0.0.1:5173/</span>
                  </span>
                </Show>
                <Show when={step() >= DEMO_SAVED_HMR}>
                  <span class="lp-wb-tline">
                    <span class="a-ok">✓</span> hmr update <span class="a-path">/src/App.tsx</span>
                  </span>
                </Show>
                <Show when={props.demo.ready()}>
                  <span class="lp-wb-tline">
                    <span class="a-path">~/vite-react</span> <span class="a-prompt">$</span>{" "}
                    <span class="lp-wb-tcur" aria-hidden="true" />
                  </span>
                </Show>
              </pre>
            </Show>
          </div>
          <div class="lp-wb-keys" aria-hidden="true">
            <div class="lp-wb-keys-row">
              <For each={SOFT_KEYS}>{(key) => <span>{key}</span>}</For>
            </div>
          </div>
        </div>

        <div class="lp-wb-status" aria-hidden="true">
          <span class="lp-wb-save-pill" data-save-state={props.demo.saveState()}>
            <Icon name="check" />
            <span>{props.demo.saveState() === "saving" ? "Saving..." : "Saved in IndexedDB"}</span>
          </span>
          <span class="lp-wb-status-end">{activeTabMeta().path}</span>
          <span>
            Ln {CARET_LINE}, Col {CARET_COLUMN}
          </span>
          <span>{activeTabMeta().lang}</span>
        </div>

        <div class="lp-wb-switcher" role="tablist" aria-label="Panes">
          <For each={PANES}>
            {(item, index) => (
              <button
                type="button"
                role="tab"
                id={tabId(item.pane)}
                aria-controls={panelId(item.pane)}
                aria-selected={pane() === item.pane}
                tabindex={pane() === item.pane ? 0 : -1}
                onClick={() => setPane(item.pane)}
                onKeyDown={(event) =>
                  handleTabListKeyDown(event, PANES, index(), (next) => setPane(next.pane))
                }
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
