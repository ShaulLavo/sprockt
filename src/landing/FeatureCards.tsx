// The four feature cards from the #4 landing: a title, two lines, and a drawn piece of the real
// workbench on the painterly ground panel. The drawings are decorative; the words carry the meaning.
import { For, type JSX } from "solid-js";
import { LANDING_COPY } from "./copy";
import { BrandLogoTile } from "./logos";

type Tok = readonly [cls: string, text: string];
type Line = readonly [n: number, tokens: readonly Tok[]];

const K = "sk";
const F = "sf";
const N = "sn";
const C = "sc";
const E = "lp-err";

const CHECK_LINES: readonly Line[] = [
  [
    8,
    [
      [K, "export function "],
      [F, "total"],
      ["", "(items: Item[]): "],
      [K, "number"],
      ["", " {"],
    ],
  ],
  [
    9,
    [
      ["", "  "],
      [K, "const "],
      ["", "sum: "],
      [K, "number"],
      ["", " = "],
      [E, "items.map((i) => i.price)"],
    ],
  ],
  [10, [[C, "  // prices are in cents"]]],
  [
    11,
    [
      ["", "  "],
      [K, "const "],
      ["", "n = items["],
      [N, "0"],
      ["", "]."],
      [E, "qty"],
    ],
  ],
  [
    12,
    [
      ["", "  "],
      [K, "if "],
      ["", "(n > "],
      [N, "0"],
      ["", ") "],
      [E, "log"],
      ["", "(n)"],
    ],
  ],
  [
    13,
    [
      ["", "  "],
      [K, "return "],
      ["", "sum"],
    ],
  ],
  [14, [["", "}"]]],
  [15, [["", " "]]],
  [
    16,
    [
      [K, "export const "],
      ["", "empty: Item[] = []"],
    ],
  ],
  [17, [["", " "]]],
  [
    18,
    [
      [K, "export function "],
      [F, "count"],
      ["", "(items: Item[]) {"],
    ],
  ],
  [
    19,
    [
      ["", "  "],
      [K, "return "],
      ["", "items.length"],
    ],
  ],
  [20, [["", "}"]]],
];

const MEMBERS: readonly (readonly [kind: "P" | "M", name: string, type: string])[] = [
  ["P", "quantity", "number"],
  ["P", "price", "number"],
  ["P", "sku", "string"],
  ["M", "toJSON", "() => object"],
  ["P", "createdAt", "Date"],
  ["P", "customer", "Customer"],
  ["P", "discount", "number"],
  ["M", "hasShipped", "() => boolean"],
  ["P", "id", "string"],
  ["P", "status", "Status"],
];

const TEST_FILES: readonly (readonly [file: string, count: string])[] = [
  ["cart.test.ts", "9 tests"],
  ["price.test.ts", "4 tests"],
  ["App.test.tsx", "2 tests"],
];

const WORKSPACES: readonly (readonly [logo: string, name: string, state: string])[] = [
  ["vite-react", "my-app", "Open in 2 tabs"],
  ["hono", "api-notes", "Saved"],
  ["astro", "docs-site", "Saved"],
  ["github", "ShaulLavo/bash-web", "Saved"],
  ["sveltekit", "kit-blog", "Saved"],
  ["next-app", "next-shop", "Saved"],
];

function Tokens(props: { readonly tokens: readonly Tok[] }) {
  return (
    <For each={props.tokens}>
      {(token) => (token[0] ? <span class={token[0]}>{token[1]}</span> : token[1])}
    </For>
  );
}

function Tick() {
  return (
    <svg class="lp-mini-tick" viewBox="0 0 16 16" aria-hidden="true">
      <path d="m3.5 8.4 2.8 2.8 6.2-6.4" />
    </svg>
  );
}

function CheckPanel() {
  return (
    <div class="lp-mini lp-mini-code lp-at-corner">
      <div class="lp-mini-tabs">
        <span class="is-on" data-tab-tone="ts">
          cart.ts
        </span>
        <span>types.ts</span>
        <em>3 problems</em>
      </div>
      <ol class="lp-mini-pre">
        <For each={CHECK_LINES}>
          {(line) => (
            <li data-n={line[0]}>
              <Tokens tokens={line[1]} />
            </li>
          )}
        </For>
      </ol>
      <div class="lp-mini-diag">
        <b>ts(2322)</b> Type 'number[]' is not assignable to type 'number'.
      </div>
    </div>
  );
}

function CompletePanel() {
  return (
    <div class="lp-mini lp-mini-complete lp-at-rise">
      <div class="lp-mini-line">
        order.
        <span class="lp-mini-caret" />
      </div>
      <ul class="lp-mini-list">
        <For each={MEMBERS}>
          {(member, index) => (
            <li classList={{ "is-on": index() === 0 }}>
              <i>{member[0]}</i>
              {member[1]}
              <span>{member[2]}</span>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}

function TerminalPanel() {
  return (
    <div class="lp-mini lp-mini-term lp-at-right">
      <div class="lp-mini-termhead">
        <span class="lp-mini-dots">
          <i />
          <i />
          <i />
        </span>
        <b>my-app</b>
        <span>bash</span>
      </div>
      <div class="lp-mini-screen">
        <p>
          <span class="lp-mini-cwd">~/my-app</span> <span class="lp-mini-sig">$</span> <b>bun test</b>
        </p>
        <p class="lp-mini-meter">
          <span class="lp-mini-bar" />3 of 3 files
        </p>
        <For each={TEST_FILES}>
          {(row) => (
            <p class="lp-mini-log">
              <Tick />
              <span>{row[0]}</span>
              <span class="lp-mini-n">{row[1]}</span>
            </p>
          )}
        </For>
        <p class="lp-mini-gap" />
        <p class="lp-mini-sum">
          <span>Test files</span>
          <b>3 passed</b>
        </p>
        <p class="lp-mini-sum">
          <span>Tests</span>
          <b>15 passed</b>
        </p>
        <p class="lp-mini-done">
          <span class="lp-mini-ok">
            <Tick />
          </span>
          <b>15 pass</b> <span class="lp-mini-dim">0 fail</span>
        </p>
        <p>
          <span class="lp-mini-cwd">~/my-app</span> <span class="lp-mini-sig">$</span> <b>bun run build</b>
        </p>
        <p class="lp-mini-log">
          <Tick />
          <span>dist/index.html</span>
        </p>
      </div>
    </div>
  );
}

function StorePanel() {
  return (
    <div class="lp-mini lp-mini-ws lp-at-low">
      <div class="lp-mini-head">Workspaces</div>
      <ul>
        <For each={WORKSPACES}>
          {(row, index) => (
            <li classList={{ "is-on": index() === 0 }}>
              <BrandLogoTile templateId={row[0]} />
              <b>{row[1]}</b>
              <span>{row[2]}</span>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}

function FeatureCard(props: {
  readonly title: string;
  readonly body: string;
  readonly fade: "b" | "br";
  readonly children: JSX.Element;
}) {
  return (
    <article class="lp-card">
      <h3>{props.title}</h3>
      <p>{props.body}</p>
      <div class="lp-panel" aria-hidden="true">
        <div class={`lp-stage lp-fade-${props.fade}`}>{props.children}</div>
      </div>
    </article>
  );
}

export function FeatureCards() {
  return (
    <div class="lp-cards">
      <FeatureCard title={LANDING_COPY.featureCheckTitle} body={LANDING_COPY.featureCheckBody} fade="br">
        <CheckPanel />
      </FeatureCard>
      <FeatureCard title={LANDING_COPY.featureCompleteTitle} body={LANDING_COPY.featureCompleteBody} fade="b">
        <CompletePanel />
      </FeatureCard>
      <FeatureCard title={LANDING_COPY.featureTermTitle} body={LANDING_COPY.featureTermBody} fade="b">
        <TerminalPanel />
      </FeatureCard>
      <FeatureCard title={LANDING_COPY.featureStoreTitle} body={LANDING_COPY.featureStoreBody} fade="b">
        <StorePanel />
      </FeatureCard>
    </div>
  );
}
