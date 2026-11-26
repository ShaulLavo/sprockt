// The iPhone workbench showcase from #4 "Sheet and Biro" (set-a/dir-1 .device), themed cleanly for
// both light and Night Shift dark. Strictly inert / visual-only.
import { Fragment } from "react";
import { SprocktLogo } from "../ui/SprocktLogo";
import { LANDING_COPY } from "./copy";

type Tok = readonly [cls: string, text: string];
type Line = readonly [n: number, tokens: readonly Tok[]];

const K = "sk";
const F = "sf";
const N = "sn";
const T = "st";

const PHONE_LINES: readonly Line[] = [
  [
    6,
    [
      [K, "function"],
      ["", " "],
      [F, "App"],
      ["", "() {"],
    ],
  ],
  [
    7,
    [
      ["", "  "],
      [K, "const"],
      ["", " [count, setCount] ="],
    ],
  ],
  [
    8,
    [
      ["", "    "],
      [F, "useState"],
      ["", "("],
      [N, "0"],
      ["", ")"],
    ],
  ],
  [9, [["", " "]]],
  [
    10,
    [
      ["", "  "],
      [K, "return"],
      ["", " ("],
    ],
  ],
  [
    11,
    [
      ["", "    <"],
      [T, "button"],
    ],
  ],
  [12, [["", "      onClick={() =>"]]],
  [
    13,
    [
      ["", "        "],
      [F, "setCount"],
      ["", "(c => c + "],
      [N, "1"],
      ["", ")}"],
    ],
  ],
  [14, [["", "    >"]]],
  [15, [["", "      count is {count}"]]],
  [
    16,
    [
      ["", "    </"],
      [T, "button"],
      ["", ">"],
    ],
  ],
  [17, [["", "  )"]]],
  [18, [["", "}"]]],
];

const ACCESSORY_KEYS = ["{ }", "( )", "=>", ";", "Tab"] as const;

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

export function PhoneShowcase() {
  return (
    <div
      className="lp-device"
      role="img"
      aria-label={LANDING_COPY.showcaseBenchFrame}
      data-testid="phone-showcase"
    >
      <div className="lp-device-screen" aria-hidden="true" inert>
        <div className="lp-ph-bar">
          <SprocktLogo class="lp-ph-mark" />
          <b>my-app</b>
          <span>App.tsx</span>
        </div>
        <ol className="lp-ph-code">
          {PHONE_LINES.map((line) => (
            <li key={line[0]} data-n={line[0]}>
              <Tokens tokens={line[1]} />
            </li>
          ))}
        </ol>
        <div className="lp-ph-keys">
          {ACCESSORY_KEYS.map((key) => (
            <span key={key}>{key}</span>
          ))}
        </div>
        <div className="lp-ph-tabs">
          <span>Files</span>
          <span className="is-on">Code</span>
          <span>Terminal</span>
          <span>Preview</span>
        </div>
      </div>
    </div>
  );
}
