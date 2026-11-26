// The stately, cropped-and-faded hero IDE showcase from #4 "Sheet and Biro" (set-a/dir-1 .hw),
// themed for both light and Night Shift dark. Strictly inert / visual-only: no focusable elements
// or half-working controls sit inside the cropped showcase.
import { Fragment } from "react";
import { LANDING_COPY } from "./copy";
import { ReactMark } from "./logos";

type Tok = readonly [cls: string, text: string];
type Line = readonly [n: number, tokens: readonly Tok[]];

const K = "sk";
const S = "ss";
const F = "sf";
const N = "sn";
const T = "st";
const H = "sf lp-hw-hov";

const HERO_LINES: readonly Line[] = [
  [
    1,
    [
      [K, "import"],
      ["", " { useState } "],
      [K, "from"],
      ["", " "],
      [S, "'react'"],
    ],
  ],
  [
    2,
    [
      [K, "import"],
      ["", " "],
      [S, "'./App.css'"],
    ],
  ],
  [3, [["", " "]]],
  [
    4,
    [
      [K, "export default function"],
      ["", " "],
      [F, "App"],
      ["", "() {"],
    ],
  ],
  [
    5,
    [
      ["", "  "],
      [K, "const"],
      ["", " [count, setCount] = "],
      [H, "useState"],
      ["", "("],
      [N, "0"],
      ["", ")"],
    ],
  ],
  [
    6,
    [
      ["", "  "],
      [K, "return"],
      ["", " ("],
    ],
  ],
  [
    7,
    [
      ["", "    <"],
      [T, "main"],
      ["", " className="],
      [S, '"app"'],
      ["", ">"],
    ],
  ],
  [
    8,
    [
      ["", "      <"],
      [T, "h1"],
      ["", ">Hello from Sprockt</"],
      [T, "h1"],
      ["", ">"],
    ],
  ],
  [
    9,
    [
      ["", "      <"],
      [T, "button"],
      ["", " onClick={() => "],
      [F, "setCount"],
      ["", "(c => c + "],
      [N, "1"],
      ["", ")}>"],
    ],
  ],
  [10, [["", "        count is {count}"]]],
  [
    11,
    [
      ["", "      </"],
      [T, "button"],
      ["", ">"],
    ],
  ],
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

export function HeroShowcase() {
  return (
    <div className="lp-hw" role="img" aria-label={LANDING_COPY.showcaseHeroFrame} data-testid="hero-showcase">
      <div className="lp-hw-inner" aria-hidden="true" inert>
        <div className="lp-hw-bar">
          <span className="lp-hw-dots">
            <i />
            <i />
            <i />
          </span>
          <span className="lp-hw-crumb">
            <b>my-app</b> · src/App.tsx
          </span>
          <span className="lp-hw-sp" />
          <span className="lp-hw-live">
            <i />
            Preview running
          </span>
        </div>
        <div className="lp-hw-body">
          <div className="lp-hw-tree">
            <span className="lp-hw-label">Explorer</span>
            <span className="lp-hw-f lp-hw-f-dir">my-app</span>
            <span className="lp-hw-f lp-hw-f-dir lp-hw-in">src</span>
            <span className="lp-hw-f lp-hw-in2 is-on">
              <span className="lp-hw-fico lp-hw-fico-react">
                <ReactMark />
              </span>
              App.tsx
            </span>
            <span className="lp-hw-f lp-hw-in2">
              <span className="lp-hw-fbadge lp-hw-fbadge-css">CSS</span>
              App.css
            </span>
            <span className="lp-hw-f lp-hw-in2">
              <span className="lp-hw-fbadge lp-hw-fbadge-ts">TS</span>
              main.tsx
            </span>
          </div>
          <div className="lp-hw-ed">
            <div className="lp-hw-tabs">
              <span className="is-on" data-tab-tone="ts">
                App.tsx
              </span>
              <span>main.tsx</span>
            </div>
            <ol className="lp-hw-code">
              {HERO_LINES.map((line) => (
                <li key={line[0]} data-n={line[0]}>
                  <Tokens tokens={line[1]} />
                </li>
              ))}
            </ol>
            <div className="lp-hw-tip">
              <span className="sk">function</span> <span className="sf">useState</span>
              &lt;S&gt;(initialState: S | (() =&gt; S)): [S, Dispatch&lt;SetStateAction&lt;S&gt;&gt;]
              <small>Returns a stateful value, and a function to update it.</small>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
