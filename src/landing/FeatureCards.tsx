// The four feature cards from the #4 landing: a title, two lines, and a drawn piece of the real
// workbench on the painterly ground panel. The drawings are decorative; the words carry the meaning.
import { Fragment, type ReactNode } from "react";
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
    <>
      {props.tokens.map((token, index) =>
        token[0] ? (
          <span key={index} className={token[0]}>
            {token[1]}
          </span>
        ) : (
          <Fragment key={index}>{token[1]}</Fragment>
        ),
      )}
    </>
  );
}

function Tick() {
  return (
    <svg className="lp-mini-tick" viewBox="0 0 16 16" aria-hidden="true">
      <path d="m3.5 8.4 2.8 2.8 6.2-6.4" />
    </svg>
  );
}

function CheckPanel() {
  return (
    <div className="lp-mini lp-mini-code lp-at-corner">
      <div className="lp-mini-tabs">
        <span className="is-on" data-tab-tone="ts">
          cart.ts
        </span>
        <span>types.ts</span>
        <em>3 problems</em>
      </div>
      <ol className="lp-mini-pre">
        {CHECK_LINES.map((line) => (
          <li key={line[0]} data-n={line[0]}>
            <Tokens tokens={line[1]} />
          </li>
        ))}
      </ol>
      <div className="lp-mini-diag">
        <b>ts(2322)</b> Type 'number[]' is not assignable to type 'number'.
      </div>
    </div>
  );
}

function CompletePanel() {
  return (
    <div className="lp-mini lp-mini-complete lp-at-rise">
      <div className="lp-mini-line">
        order.
        <span className="lp-mini-caret" />
      </div>
      <ul className="lp-mini-list">
        {MEMBERS.map((member, index) => (
          <li key={member[1]} className={index === 0 ? "is-on" : undefined}>
            <i>{member[0]}</i>
            {member[1]}
            <span>{member[2]}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TerminalPanel() {
  return (
    <div className="lp-mini lp-mini-term lp-at-right">
      <div className="lp-mini-termhead">
        <span className="lp-mini-dots">
          <i />
          <i />
          <i />
        </span>
        <b>my-app</b>
        <span>bash</span>
      </div>
      <div className="lp-mini-screen">
        <p>
          <span className="lp-mini-cwd">~/my-app</span> <span className="lp-mini-sig">$</span> <b>bun test</b>
        </p>
        <p className="lp-mini-meter">
          <span className="lp-mini-bar" />3 of 3 files
        </p>
        {TEST_FILES.map((row) => (
          <p key={row[0]} className="lp-mini-log">
            <Tick />
            <span>{row[0]}</span>
            <span className="lp-mini-n">{row[1]}</span>
          </p>
        ))}
        <p className="lp-mini-gap" />
        <p className="lp-mini-sum">
          <span>Test files</span>
          <b>3 passed</b>
        </p>
        <p className="lp-mini-sum">
          <span>Tests</span>
          <b>15 passed</b>
        </p>
        <p className="lp-mini-done">
          <span className="lp-mini-ok">
            <Tick />
          </span>
          <b>15 pass</b> <span className="lp-mini-dim">0 fail</span>
        </p>
        <p>
          <span className="lp-mini-cwd">~/my-app</span> <span className="lp-mini-sig">$</span>{" "}
          <b>bun run build</b>
        </p>
        <p className="lp-mini-log">
          <Tick />
          <span>dist/index.html</span>
        </p>
      </div>
    </div>
  );
}

function StorePanel() {
  return (
    <div className="lp-mini lp-mini-ws lp-at-low">
      <div className="lp-mini-head">Workspaces</div>
      <ul>
        {WORKSPACES.map((row, index) => (
          <li key={row[1]} className={index === 0 ? "is-on" : undefined}>
            <BrandLogoTile templateId={row[0]} />
            <b>{row[1]}</b>
            <span>{row[2]}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FeatureCard(props: {
  readonly title: string;
  readonly body: string;
  readonly fade: "b" | "br";
  readonly children: ReactNode;
}) {
  return (
    <article className="lp-card">
      <h3>{props.title}</h3>
      <p>{props.body}</p>
      <div className="lp-panel" aria-hidden="true">
        <div className={`lp-stage lp-fade-${props.fade}`}>{props.children}</div>
      </div>
    </article>
  );
}

export function FeatureCards() {
  return (
    <div className="lp-cards">
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
