// The Waffle hub from the #4 landing: Waffle at the centre and the parts that run on it around it.
// The chips are labels; the list beside the diagram links each part to its repository. Two spokes
// carry a dot out from Waffle a few times, then rest.
import type { CSSProperties } from "react";
import { LANDING_COPY } from "./copy";
import { Icon, type IconName } from "./icons";
import { LOGOS } from "./logos";

interface Spoke {
  readonly label: string;
  readonly icon?: IconName;
  readonly logo?: string;
  /** Position in percent of the frame. */
  readonly x: number;
  readonly y: number;
  /** Which edge of the chip sits on (x, y): the chip's left, right or centre. */
  readonly align: "l" | "r" | "c";
  readonly pulse?: boolean;
}

const SPOKES: readonly Spoke[] = [
  { label: "IndexedDB", icon: "drive", x: 32, y: 13, align: "c" },
  { label: "Singapore", icon: "code", x: 68, y: 13, align: "c" },
  { label: "bash-web", icon: "terminal", x: 5, y: 50, align: "l" },
  { label: "Ghostty WebGPU", icon: "monitor", x: 95, y: 50, align: "r" },
  { label: "tsrs", logo: LOGOS.typescript, x: 32, y: 87, align: "c", pulse: true },
  { label: "Bun 1.4.5", logo: LOGOS.bun, x: 68, y: 87, align: "c", pulse: true },
];

const PULSE_SPOKES = SPOKES.filter((spoke) => spoke.pulse);

const RINGS = [34, 60, 86] as const;

function Chip(props: { readonly spoke: Spoke }) {
  const { spoke } = props;
  return (
    <span className={`lp-hub-chip lp-hub-${spoke.align}`} style={{ left: `${spoke.x}%`, top: `${spoke.y}%` }}>
      {spoke.logo ? (
        <img src={spoke.logo} alt="" width="16" height="16" loading="lazy" />
      ) : (
        <Icon name={spoke.icon ?? "box"} />
      )}
      <span>{spoke.label}</span>
    </span>
  );
}

export function HubDiagram() {
  return (
    <figure className="lp-hub" role="img" aria-label={LANDING_COPY.hoodDiagram}>
      {RINGS.map((size) => (
        <span key={size} className="lp-hub-ring" style={{ "--ring": `${size}%` } as CSSProperties} />
      ))}
      <svg className="lp-hub-lines" viewBox="0 0 100 100" preserveAspectRatio="none">
        {SPOKES.map((spoke) => (
          <line key={spoke.label} x1="50" y1="50" x2={spoke.x} y2={spoke.y} />
        ))}
      </svg>
      {PULSE_SPOKES.map((spoke) => (
        <span
          key={spoke.label}
          className="lp-hub-dot"
          style={{ "--x": `${spoke.x}%`, "--y": `${spoke.y}%` } as CSSProperties}
        />
      ))}
      {SPOKES.map((spoke) => (
        <Chip key={spoke.label} spoke={spoke} />
      ))}
      <span className="lp-hub-chip lp-hub-core lp-hub-c" style={{ left: "50%", top: "50%" }}>
        <Icon name="cpu" />
        <span>Waffle</span>
      </span>
    </figure>
  );
}
