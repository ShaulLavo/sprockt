// The Waffle hub from the #4 landing: Waffle at the centre and the parts that run on it around it.
// The chips are labels; the list beside the diagram links each part to its repository. Two spokes
// carry a dot out from Waffle a few times, then rest.
import { For, Show } from "solid-js";
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

const RINGS = [34, 60, 86] as const;

function Chip(props: { readonly spoke: Spoke }) {
  return (
    <span
      class={`lp-hub-chip lp-hub-${props.spoke.align}`}
      style={{ left: `${props.spoke.x}%`, top: `${props.spoke.y}%` }}
    >
      <Show when={props.spoke.logo} fallback={<Icon name={props.spoke.icon ?? "box"} />}>
        {(logo) => <img src={logo()} alt="" width="16" height="16" loading="lazy" />}
      </Show>
      <span>{props.spoke.label}</span>
    </span>
  );
}

export function HubDiagram() {
  return (
    <figure class="lp-hub" role="img" aria-label={LANDING_COPY.hoodDiagram}>
      <For each={RINGS}>{(size) => <span class="lp-hub-ring" style={{ "--ring": `${size}%` }} />}</For>
      <svg class="lp-hub-lines" viewBox="0 0 100 100" preserveAspectRatio="none">
        <For each={SPOKES}>{(spoke) => <line x1="50" y1="50" x2={spoke.x} y2={spoke.y} />}</For>
      </svg>
      <For each={SPOKES.filter((spoke) => spoke.pulse)}>
        {(spoke) => <span class="lp-hub-dot" style={{ "--x": `${spoke.x}%`, "--y": `${spoke.y}%` }} />}
      </For>
      <For each={SPOKES}>{(spoke) => <Chip spoke={spoke} />}</For>
      <span class="lp-hub-chip lp-hub-core lp-hub-c" style={{ left: "50%", top: "50%" }}>
        <Icon name="cpu" />
        <span>Waffle</span>
      </span>
    </figure>
  );
}
