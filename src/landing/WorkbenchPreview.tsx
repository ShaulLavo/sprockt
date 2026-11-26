// Live, interactive workbench showcase for the landing page.
// Blends Sheet and Biro's crisp true-scale chrome with Precision Sheet's multicolor tabs and
// lively scripted sequence (typing, Bun 1.4.5 install, Vite dev server, TypeScript hover, save
// tick and HMR flash), while keeping zero runtime/Waffle imports on `/`.
import { Fragment, useId, useState, type CSSProperties, type KeyboardEvent } from "react";
import { useValue } from "../lib/react";
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

/** Joins the class names that apply, or gives no attribute when none does. */
function cx(...names: readonly (string | false | undefined)[]): string | undefined {
  const joined = names.filter(Boolean).join(" ");
  return joined === "" ? undefined : joined;
}

function nextTabIndex(key: string, current: number, length: number): number | undefined {
  if (length <= 0) return undefined;
  if (key === "ArrowRight" || key === "ArrowDown") return (current + 1) % length;
  if (key === "ArrowLeft" || key === "ArrowUp") return (current - 1 + length) % length;
  if (key === "Home") return 0;
  if (key === "End") return length - 1;
  return undefined;
}

function handleTabListKeyDown<T>(
  event: KeyboardEvent<HTMLButtonElement>,
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
  const mark = FILE_MARK[props.kind];
  if (!mark) return <Icon name="folder" class="lp-wb-ft lp-ft-dir" />;
  return (
    <span className={`lp-wb-ft lp-ft-${props.kind}`} aria-hidden="true">
      {mark}
    </span>
  );
}

function TreeItem(props: {
  readonly row: TreeRow;
  readonly activeFile: DemoFileId;
  readonly onOpen: (id: DemoFileId) => void;
}) {
  const { row } = props;
  const fileId = row.fileId;
  const selected = fileId !== undefined && props.activeFile === fileId;
  const isDir = row.kind === "dir" || row.kind === "dir-open";
  return (
    <li
      className={cx(
        "lp-wb-row",
        row.dim && "is-dim",
        selected && "is-selected",
        fileId !== undefined && "is-clickable",
      )}
      data-tab-tone={fileId ? fileTabTone(row.name) : undefined}
      style={{ "--depth": row.depth } as CSSProperties}
    >
      {fileId ? (
        <button
          type="button"
          className="lp-wb-row-btn"
          aria-current={selected ? "true" : undefined}
          onClick={() => props.onOpen(fileId)}
        >
          <span className="lp-wb-chev" aria-hidden="true" />
          <FileMark kind={row.kind} />
          <span>{row.name}</span>
        </button>
      ) : (
        <>
          {isDir ? (
            <Icon name={row.kind === "dir" ? "chev-r" : "chev-d"} class="lp-wb-chev" />
          ) : (
            <span className="lp-wb-chev" aria-hidden="true" />
          )}
          <FileMark kind={row.kind} />
          <span>{row.name}</span>
        </>
      )}
    </li>
  );
}

function CodeLine(props: {
  readonly line: SourceLine;
  readonly number: number;
  readonly current: boolean;
  readonly hover: boolean;
}) {
  const { line } = props;
  return (
    <li className={props.current ? "is-current" : undefined}>
      <span className="lp-wb-ln" aria-hidden="true">
        {props.number}
      </span>
      <code style={{ "--indent": line.indent } as CSSProperties}>
        {" ".repeat(line.indent)}
        {line.tokens.map((token, index) =>
          token[0] ? (
            <span
              key={index}
              className={cx(token[0], props.current && props.hover && token[1] === "useState" && "lp-wb-hov")}
            >
              {token[1]}
            </span>
          ) : (
            <Fragment key={index}>{token[1]}</Fragment>
          ),
        )}
        {props.current ? <span className="lp-wb-caret" aria-hidden="true" /> : null}
      </code>
    </li>
  );
}

function DevTerminal(props: { readonly step: number }) {
  return (
    <pre>
      <span className="lp-wb-tline">
        <span className="a-dim">$ vite --host 127.0.0.1 --port 5173 --strictPort</span>
      </span>
      <span className="lp-wb-tline">
        {"  "}
        <span className="a-ok a-bold">VITE</span> <span className="a-ok">v8.3.5</span>{" "}
        <span className="a-dim">ready</span>
      </span>
      <span className="lp-wb-tline">
        {"  "}
        <span className="a-ok">➜</span> <span className="a-bold">Local</span>:{" "}
        <span className="a-link">http://127.0.0.1:5173/</span>
      </span>
      {props.step >= DEMO_SAVED_HMR ? (
        <span className="lp-wb-tline">
          <span className="a-ok">✓</span> hmr update <span className="a-path">/src/App.tsx</span>
        </span>
      ) : null}
    </pre>
  );
}

function BashTerminal(props: {
  readonly step: number;
  readonly ready: boolean;
  readonly installTyped: string;
  readonly devTyped: string;
}) {
  const { step } = props;
  return (
    <pre>
      <span className="lp-wb-tline">
        <span className="a-path">~/vite-react</span> <span className="a-prompt">$</span>{" "}
        {step >= DEMO_INSTALL_TYPING ? props.installTyped : ""}
        {step < DEMO_INSTALL_DONE ? <span className="lp-wb-tcur" aria-hidden="true" /> : null}
      </span>
      {step >= DEMO_INSTALL_DONE ? (
        <>
          <span className="lp-wb-tline">
            <span className="a-bold">bun install</span> <span className="a-dim">v1.4.5</span>
          </span>
          <span className="lp-wb-tline">
            <span className="a-ok">+</span> react<span className="a-dim">@19.3.1</span>{" "}
            <span className="a-ok">+</span> vite<span className="a-dim">@8.3.5</span>
          </span>
          <span className="lp-wb-tline">
            <span className="a-path">~/vite-react</span> <span className="a-prompt">$</span>{" "}
            {step >= DEMO_DEV_TYPING ? props.devTyped : ""}
            {step >= DEMO_INSTALL_DONE && step < DEMO_READY ? (
              <span className="lp-wb-tcur" aria-hidden="true" />
            ) : null}
          </span>
        </>
      ) : null}
      {props.ready ? (
        <span className="lp-wb-tline">
          {"  "}
          <span className="a-ok a-bold">VITE</span> <span className="a-ok">v8.3.5</span>{" "}
          <span className="a-dim">ready</span> <span className="a-link">http://127.0.0.1:5173/</span>
        </span>
      ) : null}
      {step >= DEMO_SAVED_HMR ? (
        <span className="lp-wb-tline">
          <span className="a-ok">✓</span> hmr update <span className="a-path">/src/App.tsx</span>
        </span>
      ) : null}
      {props.ready ? (
        <span className="lp-wb-tline">
          <span className="a-path">~/vite-react</span> <span className="a-prompt">$</span>{" "}
          <span className="lp-wb-tcur" aria-hidden="true" />
        </span>
      ) : null}
    </pre>
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
  const { demo } = props;
  const [pane, setPane] = useState<PhonePane>(props.pane);
  const step = useValue(demo.step);
  const ready = useValue(demo.ready);
  const playing = useValue(demo.playing);
  const reducedMotion = useValue(demo.reducedMotion);
  const activeFile = useValue(demo.activeFile);
  const activeTerm = useValue(demo.activeTerm);
  const installTyped = useValue(demo.installTyped);
  const devTyped = useValue(demo.devTyped);
  const saveState = useValue(demo.saveState);
  const hmrFlash = useValue(demo.hmrFlash);
  const count = useValue(demo.count);

  const activeTabMeta = EDITOR_TABS.find((tab) => tab.id === activeFile) ?? EDITOR_TABS[0]!;
  const lines = DEMO_FILE_LINES[activeFile];

  const uid = useId();
  const tabId = (name: PhonePane) => `${uid}-tab-${name}`;
  const panelId = (name: PhonePane) => `${uid}-panel-${name}`;
  const panel = (name: PhonePane) =>
    ({ id: panelId(name), role: "tabpanel", "aria-labelledby": tabId(name) }) as const;

  const fileTabId = (id: DemoFileId) => `${uid}-file-tab-${id}`;
  const filePanelId = `${uid}-file-panel`;
  const termTabId = (id: DemoTerminalId) => `${uid}-term-tab-${id}`;
  const termPanelId = `${uid}-term-panel`;

  function openDemoFile(id: DemoFileId): void {
    demo.setActiveFile(id);
    setPane("code");
  }

  return (
    <div className="lp-wb-frame">
      <div
        className="lp-wb"
        data-ui="workbench"
        role="group"
        aria-label={props.label}
        data-phone-pane={pane}
        data-step={step}
        data-playing={playing ? "true" : "false"}
      >
        <div className="lp-wb-titlebar">
          <span className="lp-wb-brand">
            <Icon name="logo" class="lp-wb-mark" />
            <span className="lp-wb-brand-word">Sprockt</span>
          </span>
          <span className="lp-wb-crumb">vite-react</span>
          <span className="lp-wb-palette" aria-hidden="true">
            <Icon name="search" />
            <span>Search files and commands</span>
            <kbd>⌘K</kbd>
          </span>
          <span className="lp-wb-titlebar-right">
            {ready ? (
              <span className="lp-wb-run">
                <span className="lp-wb-lamp" aria-hidden="true" />
                dev :5173
              </span>
            ) : null}
            {reducedMotion ? null : (
              <button
                type="button"
                className="lp-wb-replay"
                aria-label={playing ? "Pause demo" : "Replay demo"}
                title={playing ? "Pause demo" : "Replay demo"}
                onClick={() => (playing ? demo.pause() : demo.replay())}
              >
                <Icon name={playing ? "stop" : "reload"} />
              </button>
            )}
          </span>
        </div>

        <div className="lp-wb-activity" aria-hidden="true">
          <span className="lp-wb-act is-open">
            <Icon name="files" />
          </span>
          <span className="lp-wb-act is-open">
            <Icon name="globe" />
          </span>
          <span className="lp-wb-act is-open is-focus">
            <Icon name="terminal" />
          </span>
        </div>

        <div className="lp-wb-pane lp-wb-explorer" {...panel("files")}>
          <div className="lp-wb-head" aria-hidden="true">
            Explorer
            <span className="lp-wb-head-dim">vite-react</span>
          </div>
          <ul className="lp-wb-tree">
            {TREE.map((row) => (
              <TreeItem key={row.name} row={row} activeFile={activeFile} onOpen={openDemoFile} />
            ))}
          </ul>
        </div>

        <div className="lp-wb-pane lp-wb-editor" {...panel("code")}>
          <div className="lp-wb-strip" role="tablist" aria-label="Open files">
            {EDITOR_TABS.map((tab, index) => {
              const isActive = activeFile === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  id={fileTabId(tab.id)}
                  className={cx("lp-wb-tab", isActive && "is-active")}
                  aria-selected={isActive}
                  aria-controls={filePanelId}
                  tabIndex={isActive ? 0 : -1}
                  data-tab-tone={fileTabTone(tab.id)}
                  onClick={() => demo.setActiveFile(tab.id)}
                  onKeyDown={(event) =>
                    handleTabListKeyDown(event, EDITOR_TABS, index, (next) => demo.setActiveFile(next.id))
                  }
                >
                  <FileMark kind={tab.kind} />
                  <span>{tab.id}</span>
                </button>
              );
            })}
          </div>
          <div
            id={filePanelId}
            className="lp-wb-code-wrap"
            role="tabpanel"
            aria-labelledby={fileTabId(activeFile)}
          >
            <ol className="lp-wb-code">
              {lines.map((line, index) => (
                <CodeLine
                  key={index}
                  line={line}
                  number={index + 1}
                  current={activeFile === "App.tsx" && index + 1 === CARET_LINE}
                  hover={step >= DEMO_HOVER_EDIT}
                />
              ))}
            </ol>
            {activeFile === "App.tsx" && step === DEMO_HOVER_EDIT ? (
              <div className="lp-wb-hover" aria-hidden="true">
                <div className="lp-wb-hover-sig">
                  <span className="sk">function</span> <span className="sf">useState</span>
                  &lt;S&gt;(initialState: S | (() =&gt; S)): [S, Dispatch&lt;SetStateAction&lt;S&gt;&gt;]
                </div>
                <div className="lp-wb-hover-meta">
                  <span>tsrs · TypeScript LSP</span>
                  <span className="lp-wb-hover-ok">0 errors</span>
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <div className="lp-wb-pane lp-wb-preview" {...panel("preview")}>
          <div className="lp-wb-head" aria-hidden="true">
            <span className="lp-wb-url">
              <span className={cx("lp-wb-url-dot", ready && "is-live")} />
              <span className="lp-wb-url-text">vite-react-5173-pv.sprockt.dev</span>
              <Icon name="external" />
            </span>
          </div>
          {ready ? (
            <div className={cx("lp-wb-app", hmrFlash && "is-hmr")}>
              <span className="lp-wb-app-badge">
                {step >= DEMO_SAVED_HMR ? "HMR updated · src/App.tsx" : "Port 5173 · Live"}
              </span>
              <p className="lp-wb-app-title">Hello from bun.wasm</p>
              <p className="lp-wb-app-tagline">
                Vite serves this React app through Bun, running in your browser.
              </p>
              <button type="button" className="lp-wb-app-counter" onClick={() => demo.bump()}>
                count is {count}
              </button>
              <p className="lp-wb-app-hint">
                Edit <code>src/App.tsx</code> and the page updates without losing the count.
              </p>
            </div>
          ) : (
            <div className="lp-wb-empty">
              <p>
                {step >= DEMO_DEV_TYPING
                  ? "Starting Vite dev server on port 5173..."
                  : "Installing packages in this browser tab..."}
              </p>
            </div>
          )}
        </div>

        <div className="lp-wb-pane lp-wb-terminal" {...panel("terminal")}>
          <div className="lp-wb-strip" role="tablist" aria-label="Terminal tabs">
            {TERM_TABS.map((tab, index) => {
              const isActive = activeTerm === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  id={termTabId(tab.id)}
                  className={cx("lp-wb-tab", isActive && "is-active")}
                  aria-selected={isActive}
                  aria-controls={termPanelId}
                  tabIndex={isActive ? 0 : -1}
                  data-tab-tone={tab.tone}
                  onClick={() => demo.setActiveTerm(tab.id)}
                  onKeyDown={(event) =>
                    handleTabListKeyDown(event, TERM_TABS, index, (next) => demo.setActiveTerm(next.id))
                  }
                >
                  <span className="lp-wb-term-dot" aria-hidden="true" />
                  <span>{tab.label}</span>
                </button>
              );
            })}
            <span className="lp-wb-strip-meta" aria-hidden="true">
              Ghostty WebGPU
            </span>
          </div>
          <div
            id={termPanelId}
            className="lp-wb-term"
            role="tabpanel"
            aria-labelledby={termTabId(activeTerm)}
          >
            {activeTerm === "bash" ? (
              <BashTerminal step={step} ready={ready} installTyped={installTyped} devTyped={devTyped} />
            ) : (
              <DevTerminal step={step} />
            )}
          </div>
          <div className="lp-wb-keys" aria-hidden="true">
            <div className="lp-wb-keys-row">
              {SOFT_KEYS.map((key) => (
                <span key={key}>{key}</span>
              ))}
            </div>
          </div>
        </div>

        <div className="lp-wb-status" aria-hidden="true">
          <span className="lp-wb-save-pill" data-save-state={saveState}>
            <Icon name="check" />
            <span>{saveState === "saving" ? "Saving..." : "Saved in IndexedDB"}</span>
          </span>
          <span className="lp-wb-status-end">{activeTabMeta.path}</span>
          <span>
            Ln {CARET_LINE}, Col {CARET_COLUMN}
          </span>
          <span>{activeTabMeta.lang}</span>
        </div>

        <div className="lp-wb-switcher" role="tablist" aria-label="Panes">
          {PANES.map((item, index) => (
            <button
              key={item.pane}
              type="button"
              role="tab"
              id={tabId(item.pane)}
              aria-controls={panelId(item.pane)}
              aria-selected={pane === item.pane}
              tabIndex={pane === item.pane ? 0 : -1}
              onClick={() => setPane(item.pane)}
              onKeyDown={(event) => handleTabListKeyDown(event, PANES, index, (next) => setPane(next.pane))}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
