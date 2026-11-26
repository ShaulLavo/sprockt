// The Waffle hub from the #4 landing: Waffle at the centre, the parts that run on it around it,
// each linked to its real repository. Two spokes carry a short pulse a few times, then rest.
import { For, Show } from "solid-js";
import { LANDING_COPY } from "./copy";
import { Icon, type IconName } from "./icons";
import { LOGOS } from "./logos";

interface Spoke {
  readonly label: string;
  readonly repo?: string;
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
  { label: "Singapore", repo: "singapore", icon: "code", x: 68, y: 13, align: "c" },
  { label: "bash-web", repo: "bash-web", icon: "terminal", x: 5, y: 50, align: "l" },
  { label: "Ghostty WebGPU", repo: "ghostty-webgpu", icon: "monitor", x: 95, y: 50, align: "r" },
  { label: "tsrs", repo: "tsrs", logo: LOGOS.typescript, x: 32, y: 87, align: "c", pulse: true },
  { label: "Bun 1.4.5", repo: "bun-wasm", logo: LOGOS.bun, x: 68, y: 87, align: "c", pulse: true },
];

const RINGS = [34, 60, 86] as const;

function repoUrl(repo: string): string {
  return `https://github.com/ShaulLavo/${repo}`;
}

function ChipBody(props: { readonly spoke: Spoke }) {
  return (
    <>
      <Show when={props.spoke.logo} fallback={<Icon name={props.spoke.icon ?? "box"} />}>
        {(logo) => <img src={logo()} alt="" width="16" height="16" loading="lazy" />}
      </Show>
      <span>{props.spoke.label}</span>
    </>
  );
}

function Chip(props: { readonly spoke: Spoke }) {
  const style = () => ({ left: `${props.spoke.x}%`, top: `${props.spoke.y}%` });
  const cls = () => `lp-hub-chip lp-hub-${props.spoke.align}`;
  return (
    <Show
      when={props.spoke.repo}
      fallback={
        <span class={cls()} style={style()}>
          <ChipBody spoke={props.spoke} />
        </span>
      }
    >
      {(repo) => (
        <a class={cls()} style={style()} href={repoUrl(repo())} target="_blank" rel="noreferrer">
          <ChipBody spoke={props.spoke} />
        </a>
      )}
    </Show>
  );
}

export function HubDiagram() {
  return (
    <figure class="lp-hub" aria-label={LANDING_COPY.hoodDiagram}>
      <For each={RINGS}>
        {(size) => <span class="lp-hub-ring" style={{ "--ring": `${size}%` }} aria-hidden="true" />}
      </For>
      <svg class="lp-hub-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <For each={SPOKES}>
          {(spoke) => (
            <>
              <line x1="50" y1="50" x2={spoke.x} y2={spoke.y} />
              <Show when={spoke.pulse}>
                <line class="lp-hub-pulse" x1="50" y1="50" x2={spoke.x} y2={spoke.y} pathLength="100" />
              </Show>
            </>
          )}
        </For>
      </svg>
      <For each={SPOKES}>{(spoke) => <Chip spoke={spoke} />}</For>
      <a
        class="lp-hub-chip lp-hub-core lp-hub-c"
        style={{ left: "50%", top: "50%" }}
        href={repoUrl("waffle")}
        target="_blank"
        rel="noreferrer"
      >
        <Icon name="cpu" />
        <span>Waffle</span>
      </a>
    </figure>
  );
}
