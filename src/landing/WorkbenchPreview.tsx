// Lightweight static+interactive Circuit workbench showcase for the landing hero.
// Renders the actual Vite + React starter template source and output with zero runtime JS.
import { createSignal } from "solid-js";
import { Icon } from "./icons";
import { LOGOS } from "./logos";

type PhonePane = "files" | "code" | "preview" | "terminal";

export function WorkbenchPreview() {
  const [pane, setPane] = createSignal<PhonePane>("code");
  const [count, setCount] = createSignal(3);

  return (
    <div
      class="lp-app-frame lp-hero-frame"
      data-phone-pane={pane()}
      aria-label="Sprockt workbench running a Vite + React project"
    >
      <div class="lp-wb">
        {/* Title bar */}
        <div class="lp-wb-titlebar">
          <div class="lp-wb-brand">
            <span class="lp-wb-brand-mark">
              <Icon name="logo" />
            </span>
            <span class="lp-wb-brand-word">Sprockt</span>
          </div>
          <div class="lp-wb-crumbs">
            <span class="lp-wb-crumb-project">vite-react</span>
            <span class="lp-wb-crumb-sep">/</span>
            <span class="lp-wb-crumb-branch">
              <Icon name="branch" />
              main
            </span>
          </div>
          <div class="lp-wb-palette" aria-hidden="true">
            <Icon name="search" />
            <span class="lp-wb-palette-text">Search files and commands</span>
            <kbd>⌘K</kbd>
          </div>
          <div class="lp-wb-titlebar-right">
            <span class="lp-wb-run-state">
              <span class="lp-wb-pulse" aria-hidden="true" />
              <span class="lp-wb-run-label">dev</span>
              <span class="lp-wb-run-port">:5173</span>
            </span>
          </div>
        </div>

        {/* Activity bar */}
        <div class="lp-wb-activitybar" aria-hidden="true">
          <span class="lp-wb-act is-active">
            <Icon name="files" />
          </span>
          <span class="lp-wb-act">
            <Icon name="search" />
          </span>
          <span class="lp-wb-act">
            <Icon name="branch" />
            <span class="lp-wb-badge">2</span>
          </span>
          <span class="lp-wb-act">
            <Icon name="box" />
          </span>
          <span class="lp-wb-act">
            <Icon name="play" />
          </span>
          <span class="lp-wb-act-spacer" />
          <span class="lp-wb-act">
            <Icon name="sliders" />
          </span>
        </div>

        {/* Explorer */}
        <div class="lp-wb-pane lp-wb-explorer">
          <div class="lp-wb-pane-head">
            <span class="lp-wb-pane-title">Explorer</span>
            <span class="lp-wb-pane-actions" aria-hidden="true">
              <span>
                <Icon name="file-plus" />
              </span>
              <span>
                <Icon name="folder-plus" />
              </span>
              <span>
                <Icon name="collapse" />
              </span>
            </span>
          </div>
          <div class="lp-wb-tree-root">
            <Icon name="chev-d" />
            vite-react
          </div>
          <ul class="lp-wb-tree">
            <li class="lp-wb-row is-dir is-dim" style={{ "--depth": 0 }}>
              <Icon name="chev-r" class="lp-wb-chev" />
              <Icon name="folder" class="lp-wb-ft" />
              <span class="lp-wb-name">node_modules</span>
            </li>
            <li class="lp-wb-row is-dir" style={{ "--depth": 0 }}>
              <Icon name="chev-d" class="lp-wb-chev" />
              <Icon name="folder" class="lp-wb-ft" />
              <span class="lp-wb-name">src</span>
              <span class="lp-wb-git-dot" />
            </li>
            <li class="lp-wb-row is-selected" style={{ "--depth": 1 }}>
              <span class="lp-wb-chev-space" />
              <span class="lp-wb-badge-ft lp-ft-tsx">TX</span>
              <span class="lp-wb-name">App.tsx</span>
              <span class="lp-wb-git lp-git-m">M</span>
            </li>
            <li class="lp-wb-row" style={{ "--depth": 1 }}>
              <span class="lp-wb-chev-space" />
              <span class="lp-wb-badge-ft lp-ft-css">#</span>
              <span class="lp-wb-name">App.css</span>
            </li>
            <li class="lp-wb-row" style={{ "--depth": 1 }}>
              <span class="lp-wb-chev-space" />
              <span class="lp-wb-badge-ft lp-ft-tsx">TX</span>
              <span class="lp-wb-name">main.tsx</span>
            </li>
            <li class="lp-wb-row" style={{ "--depth": 0 }}>
              <span class="lp-wb-chev-space" />
              <span class="lp-wb-badge-ft lp-ft-html">&lt;&gt;</span>
              <span class="lp-wb-name">index.html</span>
            </li>
            <li class="lp-wb-row" style={{ "--depth": 0 }}>
              <span class="lp-wb-chev-space" />
              <span class="lp-wb-badge-ft lp-ft-json">{"{}"}</span>
              <span class="lp-wb-name">package.json</span>
            </li>
            <li class="lp-wb-row" style={{ "--depth": 0 }}>
              <span class="lp-wb-chev-space" />
              <span class="lp-wb-badge-ft lp-ft-ts">TS</span>
              <span class="lp-wb-name">vite.config.ts</span>
            </li>
          </ul>
          <div class="lp-wb-explorer-foot">
            <span class="lp-wb-foot-line is-muted">
              <Icon name="drive" />
              Saved in IndexedDB
            </span>
          </div>
        </div>

        {/* Editor: exact lines from the Vite + React starter template, zero clipping */}
        <div class="lp-wb-pane lp-wb-editor">
          <div class="lp-wb-tabs" aria-hidden="true">
            <span class="lp-wb-tab is-active">
              <span class="lp-wb-badge-ft lp-ft-tsx">TX</span>
              <span>App.tsx</span>
              <span class="lp-wb-tab-end">
                <Icon name="x" class="lp-wb-tab-x" />
              </span>
            </span>
            <span class="lp-wb-tab">
              <span class="lp-wb-badge-ft lp-ft-css">#</span>
              <span>App.css</span>
            </span>
            <span class="lp-wb-tab">
              <span class="lp-wb-badge-ft lp-ft-ts">TS</span>
              <span>vite.config.ts</span>
            </span>
            <span class="lp-wb-tabs-fill" />
            <span class="lp-wb-tabs-actions">
              <span>
                <Icon name="split" />
              </span>
            </span>
          </div>
          <div class="lp-wb-crumbbar" aria-hidden="true">
            <span>src</span>
            <Icon name="chev-r" />
            <span>App.tsx</span>
            <Icon name="chev-r" />
            <span class="lp-wb-crumb-sym">App</span>
          </div>
          <div class="lp-wb-code">
            <ol class="lp-wb-lines">
              <li class="lp-wb-line">
                <span class="lp-wb-ln">1</span>
                <code class="lp-wb-lc">
                  <span class="sk">import</span> <span class="sp">{"{"}</span>{" "}
                  <span class="sv">useState</span> <span class="sp">{"}"}</span> <span class="sk">from</span>{" "}
                  <span class="ss">&quot;react&quot;</span>
                  <span class="sp">;</span>
                </code>
              </li>
              <li class="lp-wb-line">
                <span class="lp-wb-ln">2</span>
                <code class="lp-wb-lc">
                  <span class="sk">import</span> <span class="ss">&quot;./App.css&quot;</span>
                  <span class="sp">;</span>
                </code>
              </li>
              <li class="lp-wb-line">
                <span class="lp-wb-ln">3</span>
                <code class="lp-wb-lc" />
              </li>
              <li class="lp-wb-line">
                <span class="lp-wb-ln">4</span>
                <code class="lp-wb-lc">
                  <span class="sk">export default function</span> <span class="sf">App</span>
                  <span class="sp">() {"{"}</span>
                </code>
              </li>
              <li class="lp-wb-line is-modified">
                <span class="lp-wb-ln">5</span>
                <code class="lp-wb-lc">
                  {"  "}
                  <span class="sk">const</span> <span class="sp">[</span>
                  <span class="sv">n</span>
                  <span class="sp">,</span> <span class="sv">setN</span>
                  <span class="sp">]</span> <span class="so">=</span> <span class="sf">useState</span>
                  <span class="sp">(</span>
                  <span class="sn">{count()}</span>
                  <span class="sp">);</span>
                </code>
              </li>
              <li class="lp-wb-line">
                <span class="lp-wb-ln">6</span>
                <code class="lp-wb-lc" />
              </li>
              <li class="lp-wb-line">
                <span class="lp-wb-ln">7</span>
                <code class="lp-wb-lc">
                  {"  "}
                  <span class="sk">return</span> <span class="sp">(</span>
                </code>
              </li>
              <li class="lp-wb-line">
                <span class="lp-wb-ln">8</span>
                <code class="lp-wb-lc">
                  {"    "}
                  <span class="sp">&lt;</span>
                  <span class="stg">main</span> <span class="sa">className</span>
                  <span class="so">=</span>
                  <span class="ss">&quot;app&quot;</span>
                  <span class="sp">&gt;</span>
                </code>
              </li>
              <li class="lp-wb-line">
                <span class="lp-wb-ln">9</span>
                <code class="lp-wb-lc">
                  {"      "}
                  <span class="sp">&lt;</span>
                  <span class="stg">h1</span>
                  <span class="sp">&gt;</span>Hello from bun.wasm<span class="sp">&lt;/</span>
                  <span class="stg">h1</span>
                  <span class="sp">&gt;</span>
                </code>
              </li>
              <li class="lp-wb-line is-current">
                <span class="lp-wb-ln">10</span>
                <code class="lp-wb-lc">
                  {"      "}
                  <span class="sp">&lt;</span>
                  <span class="stg">button</span> <span class="sa">className</span>
                  <span class="so">=</span>
                  <span class="ss">&quot;counter&quot;</span>
                  <span class="lp-wb-caret" aria-hidden="true" />
                </code>
              </li>
              <li class="lp-wb-line is-added">
                <span class="lp-wb-ln">11</span>
                <code class="lp-wb-lc">
                  {"        "}
                  <span class="sa">onClick</span>
                  <span class="so">=</span>
                  <span class="sp">{"{() => "}</span>
                  <span class="sf">setN</span>
                  <span class="sp">(</span>
                  <span class="sv">n</span> <span class="so">+</span> <span class="sn">1</span>
                  <span class="sp">)</span>
                  <span class="sp">{"}"}</span>
                  <span class="sp">&gt;</span>
                </code>
              </li>
              <li class="lp-wb-line">
                <span class="lp-wb-ln">12</span>
                <code class="lp-wb-lc">
                  {"        "}count is <span class="sp">{"{"}</span>
                  <span class="sv">n</span>
                  <span class="sp">{"}"}</span>
                </code>
              </li>
              <li class="lp-wb-line">
                <span class="lp-wb-ln">13</span>
                <code class="lp-wb-lc">
                  {"      "}
                  <span class="sp">&lt;/</span>
                  <span class="stg">button</span>
                  <span class="sp">&gt;</span>
                </code>
              </li>
              <li class="lp-wb-line">
                <span class="lp-wb-ln">14</span>
                <code class="lp-wb-lc">
                  {"    "}
                  <span class="sp">&lt;/</span>
                  <span class="stg">main</span>
                  <span class="sp">&gt;</span>
                </code>
              </li>
              <li class="lp-wb-line">
                <span class="lp-wb-ln">15</span>
                <code class="lp-wb-lc">
                  {"  "}
                  <span class="sp">);</span>
                </code>
              </li>
              <li class="lp-wb-line">
                <span class="lp-wb-ln">16</span>
                <code class="lp-wb-lc">
                  <span class="sp">{"}"}</span>
                </code>
              </li>
            </ol>
          </div>
        </div>

        {/* Preview: matches the real Vite + React starter template */}
        <div class="lp-wb-pane lp-wb-preview">
          <div class="lp-wb-preview-bar" aria-hidden="true">
            <span class="lp-wb-nav-btns">
              <span>
                <Icon name="left" />
              </span>
              <span class="is-dim">
                <Icon name="right" />
              </span>
              <span>
                <Icon name="reload" />
              </span>
            </span>
            <span class="lp-wb-url">
              <Icon name="globe" />
              <span>localhost:5173/</span>
            </span>
            <span class="lp-wb-port">
              <span>:5173</span>
              <Icon name="chev-d" />
            </span>
            <span class="lp-wb-open-ext">
              <Icon name="external" />
            </span>
          </div>
          <div class="lp-wb-preview-stage">
            <div class="lp-wb-demo">
              <div class="lp-wb-demo-brand">
                <img src={LOGOS.react} alt="" width="34" height="30" />
                <span class="lp-wb-demo-plus" aria-hidden="true">
                  +
                </span>
                <img src={LOGOS.bun} alt="" width="32" height="28" />
              </div>
              <div class="lp-wb-demo-title">Hello from bun.wasm</div>
              <p class="lp-wb-demo-tagline">
                Vite serves this React app through Bun, running in your browser.
              </p>
              <button type="button" class="lp-wb-demo-counter" onClick={() => setCount((value) => value + 1)}>
                count is {count()}
              </button>
              <p class="lp-wb-demo-hint">
                Edit <code>src/App.tsx</code> and the page updates without losing the count.
              </p>
            </div>
          </div>
        </div>

        {/* Terminal */}
        <div class="lp-wb-pane lp-wb-terminal">
          <div class="lp-wb-term-tabs" aria-hidden="true">
            <span class="lp-wb-ttab">
              <Icon name="terminal" />
              bash
            </span>
            <span class="lp-wb-ttab is-active">
              <span class="lp-wb-pulse" />
              bun run dev
            </span>
            <span class="lp-wb-ttab">
              <Icon name="terminal" />
              bun test
            </span>
            <span class="lp-wb-ttab-add">
              <Icon name="plus" />
            </span>
            <span class="lp-wb-tabs-fill" />
            <span class="lp-wb-tabs-actions">
              <span>
                <Icon name="split" />
              </span>
              <span>
                <Icon name="trash" />
              </span>
            </span>
          </div>
          <div class="lp-wb-term-scroll">
            <pre class="lp-wb-term-out">
              <span class="a-prompt">~/vite-react</span> <span class="a-dim">$</span> bun run dev
              {"\n"}
              <span class="a-m">$</span> <span class="a-dim">vite --host 127.0.0.1 --port 5173</span>
              {"\n\n  "}
              <span class="a-g a-b">VITE</span> <span class="a-g">v8.3.5</span>{" "}
              <span class="a-dim">ready</span>
              {"\n\n  "}
              <span class="a-g">➜</span> <span class="a-b">Local</span>:{" "}
              <span class="a-c">
                http://127.0.0.1:<span class="a-b">5173</span>/
              </span>
              {"\n"}
              <span class="a-dim">10:42:18</span> <span class="a-c a-b">[vite]</span>{" "}
              <span class="a-g">hmr update</span> <span class="a-dim">/src/App.tsx</span>
              {"\n"}
              <span class="lp-wb-tcur" aria-hidden="true" />
            </pre>
          </div>
        </div>

        {/* Status bar: single authoritative home for "2 tabs" */}
        <div class="lp-wb-statusbar" aria-hidden="true">
          <span class="lp-wb-sb-item">
            <Icon name="branch" />
            main*
          </span>
          <span class="lp-wb-sb-item">
            <Icon name="cpu" />
            Bun 1.4.4 in WebAssembly
          </span>
          <span class="lp-wb-sb-fill" />
          <span class="lp-wb-sb-item">Ln 10, Col 34</span>
          <span class="lp-wb-sb-item">UTF-8</span>
          <span class="lp-wb-sb-item">TypeScript JSX</span>
          <span class="lp-wb-sb-item lp-wb-sb-live">
            <span class="lp-wb-live-dot" />2 tabs
          </span>
        </div>

        {/* Phone pane switcher */}
        <div class="lp-wb-pane-switch" role="tablist" aria-label="Preview panes">
          <button
            type="button"
            role="tab"
            aria-selected={pane() === "files"}
            class={pane() === "files" ? "is-active" : undefined}
            onClick={() => setPane("files")}
          >
            <Icon name="files" />
            <span>Files</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={pane() === "code"}
            class={pane() === "code" ? "is-active" : undefined}
            onClick={() => setPane("code")}
          >
            <Icon name="code" />
            <span>Code</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={pane() === "preview"}
            class={pane() === "preview" ? "is-active" : undefined}
            onClick={() => setPane("preview")}
          >
            <Icon name="globe" />
            <span>Preview</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={pane() === "terminal"}
            class={pane() === "terminal" ? "is-active" : undefined}
            onClick={() => setPane("terminal")}
          >
            <Icon name="terminal" />
            <span>Terminal</span>
          </button>
        </div>
      </div>
    </div>
  );
}
