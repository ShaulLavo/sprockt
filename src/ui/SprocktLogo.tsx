// The Sprockt brand mark: an 8-tooth sprocket gear outline in currentColor with `< >` code
// brackets in the active theme accent (biro blue in light, cornflower blue in dark).
import type { JSX } from "solid-js";

export const SPROCKT_GEAR_PATH =
  "M10.5 3h3l.5 2.1a6.6 6.6 0 0 1 1.7.7l1.8-1.1 2.1 2.1-1.1 1.8c.3.5.5 1.1.7 1.7L21 10.5v3l-2.1.5a6.6 6.6 0 0 1-.7 1.7l1.1 1.8-2.1 2.1-1.8-1.1a6.6 6.6 0 0 1-1.7.7L13.5 21h-3l-.5-2.1a6.6 6.6 0 0 1-1.7-.7l-1.8 1.1-2.1-2.1 1.1-1.8a6.6 6.6 0 0 1-.7-1.7L3 13.5v-3l2.1-.5c.2-.6.4-1.2.7-1.7L4.7 6.5l2.1-2.1 1.8 1.1c.5-.3 1.1-.5 1.7-.7L10.5 3Z";

export const SPROCKT_BRACKETS_PATH = "M10.2 9.2 7.8 12l2.4 2.8M13.8 9.2 16.2 12l-2.4 2.8";

export const SPROCKT_LOGO_INNER =
  `<path d="${SPROCKT_GEAR_PATH}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>` +
  `<path d="${SPROCKT_BRACKETS_PATH}" fill="none" stroke="var(--accent, #1a4be0)" stroke-width="1.9" stroke-linecap="square"/>`;

export function SprocktLogo(props: { readonly class?: string }): JSX.Element {
  return (
    <svg class={props.class} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d={SPROCKT_GEAR_PATH} stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
      <path
        d={SPROCKT_BRACKETS_PATH}
        stroke="var(--accent, #1a4be0)"
        stroke-width="1.9"
        stroke-linecap="square"
      />
    </svg>
  );
}
