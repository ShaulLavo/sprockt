// The four feature cards combining #4 "Sheet and Biro"'s crisp workbench fragments with #2
// "Precision Sheet"'s per-card distinct painterly-landscape textures (sky blue, warm sand, sage
// meadow, deep coastal teal — harmonized for both light and Night Shift dark).
import { Fragment, useEffect, useRef, type ReactNode } from "react";
import { LANDING_COPY } from "./copy";
import {
  painterlyFallbackCSS,
  renderPainterlyLandscape,
  type FeatureCardTone,
} from "./effects/painterly-landscape";
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
          <i className="lp-mini-badge lp-mini-badge-ts">TS</i>
          cart.ts
        </span>
        <span>
          <i className="lp-mini-badge lp-mini-badge-ts">TS</i>
          types.ts
        </span>
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
        <b>ts(2322)</b> Type &apos;Array&lt;number&gt;&apos; is not assignable to type &apos;number&apos;.
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
        <span className="lp-mini-branch">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="5" cy="3.5" r="1.5" />
            <circle cx="5" cy="12.5" r="1.5" />
            <circle cx="11" cy="5.5" r="1.5" />
            <path d="M5 5v6M11 7c0 2.6-6 1.8-6 4" />
          </svg>
          main
        </span>
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
        <p className="lp-mini-log">
          <Tick />
          <span>dist/assets/index.js</span>
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

function PainterlyBackdrop(props: { readonly tone: FeatureCardTone; readonly scheme: "light" | "dark" }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;

    const paint = () => {
      const w = host.clientWidth || 560;
      const h = host.clientHeight || 420;
      const ok = renderPainterlyLandscape(canvas, props.tone, props.scheme, w, h);
      if (ok) {
        canvas.style.opacity = "1";
        host.style.background = "";
      } else {
        canvas.style.opacity = "0";
        host.style.background = painterlyFallbackCSS(props.tone, props.scheme);
      }
    };

    paint();
    const ro = new ResizeObserver(paint);
    ro.observe(host);
    return () => ro.disconnect();
  }, [props.tone, props.scheme]);

  return (
    <div ref={hostRef} className="lp-panel-bg" data-card-tone={props.tone} aria-hidden="true">
      <canvas ref={canvasRef} className="lp-panel-canvas" aria-hidden="true" />
      <div className="lp-panel-grain" aria-hidden="true" />
    </div>
  );
}

function FeatureCard(props: {
  readonly title: string;
  readonly body: string;
  readonly fade: "b" | "br";
  readonly tone: FeatureCardTone;
  readonly scheme: "light" | "dark";
  readonly children: ReactNode;
}) {
  return (
    <article className="lp-card" data-testid={`feature-card-${props.tone}`}>
      <h3>{props.title}</h3>
      <p>{props.body}</p>
      <div className="lp-panel" data-card-tone={props.tone} aria-hidden="true">
        <PainterlyBackdrop tone={props.tone} scheme={props.scheme} />
        <div className={`lp-stage lp-fade-${props.fade}`}>{props.children}</div>
      </div>
    </article>
  );
}

export function FeatureCards(props: { readonly scheme: "light" | "dark" }) {
  return (
    <div className="lp-cards">
      <FeatureCard
        title={LANDING_COPY.featureCheckTitle}
        body={LANDING_COPY.featureCheckBody}
        fade="br"
        tone="check"
        scheme={props.scheme}
      >
        <CheckPanel />
      </FeatureCard>
      <FeatureCard
        title={LANDING_COPY.featureCompleteTitle}
        body={LANDING_COPY.featureCompleteBody}
        fade="b"
        tone="complete"
        scheme={props.scheme}
      >
        <CompletePanel />
      </FeatureCard>
      <FeatureCard
        title={LANDING_COPY.featureTermTitle}
        body={LANDING_COPY.featureTermBody}
        fade="b"
        tone="terminal"
        scheme={props.scheme}
      >
        <TerminalPanel />
      </FeatureCard>
      <FeatureCard
        title={LANDING_COPY.featureStoreTitle}
        body={LANDING_COPY.featureStoreBody}
        fade="b"
        tone="store"
        scheme={props.scheme}
      >
        <StorePanel />
      </FeatureCard>
    </div>
  );
}
