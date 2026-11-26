// Stroke icons on a 24x24 grid. Width, stroke and color come from the `.ico` class and the
// surrounding text color. The logo is the 8-tooth sprocket with `< >` brackets from ./SprocktLogo.
import type { JSX } from "solid-js";
import { SPROCKT_LOGO_INNER } from "./SprocktLogo";

const PATHS = {
  logo: SPROCKT_LOGO_INNER,
  files:
    '<path d="M15 3H9a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z"/><path d="M15 3v5h5"/><path d="M4 8v11a2 2 0 0 0 2 2h9"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  branch:
    '<circle cx="6.5" cy="5.5" r="2.2"/><circle cx="6.5" cy="18.5" r="2.2"/><circle cx="17.5" cy="7.5" r="2.2"/><path d="M6.5 7.7v8.6"/><path d="M17.5 9.7c0 4.3-5.5 3.6-10 6.2"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  "chev-d": '<path d="m6 9.5 6 6 6-6"/>',
  "chev-u": '<path d="m6 14.5 6-6 6 6"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  split: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M12 4.5v15"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5"/>',
  terminal: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="m7 9.5 3 2.5-3 2.5M12.5 15H17"/>',
  globe:
    '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.3 2.4 3.5 5.2 3.5 8.5s-1.2 6.1-3.5 8.5c-2.3-2.4-3.5-5.2-3.5-8.5s1.2-6.1 3.5-8.5z"/>',
  code: '<path d="m8.5 7-5 5 5 5M15.5 7l5 5-5 5"/>',
  sun: '<circle cx="12" cy="12" r="3.8"/><path d="M12 2.8v2M12 19.2v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2.8 12h2M19.2 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M19.5 14.5A7.5 7.5 0 1 1 9.5 4.5a6 6 0 0 0 10 10z"/>',
  auto: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  alert: '<path d="M12 4 3 19.5h18z"/><path d="M12 10v4.5M12 17h.01"/>',
  tabs: '<rect x="3" y="8" width="13" height="12" rx="1.5"/><path d="M7.5 8V5.5A1.5 1.5 0 0 1 9 4h10.5A1.5 1.5 0 0 1 21 5.5v8.5a1.5 1.5 0 0 1-1.5 1.5H16"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  more: '<path d="M5.5 12h.01M12 12h.01M18.5 12h.01" stroke-width="3"/>',
  share:
    '<path d="M12 15V4.5M7.5 9 12 4.5 16.5 9"/><path d="M4.5 15v3.5a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1V15"/>',
  download:
    '<path d="M12 4.5V15M7.5 10.5 12 15l4.5-4.5"/><path d="M4.5 15v3.5a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1V15"/>',
  reload: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4"/>',
  save: '<path d="M5 4.5h11.5l3 3v12h-14.5z"/><path d="M8.5 4.5v4h6.5v-4M8.5 19.5v-6h7v6"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="1.5"/><path d="M9.5 9.5h5v5h-5zM9 2.5V6M15 2.5V6M9 18v3.5M15 18v3.5M2.5 9H6M2.5 15H6M18 9h3.5M18 15h3.5"/>',
  drive: '<rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M5.5 13 8 5h8l2.5 8M7 16.5h.01"/>',
  "sidebar-left": '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M9 4.5v15"/>',
  "sidebar-right": '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M15 4.5v15"/>',
  "panel-bottom": '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 14h17"/>',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon(props: { name: IconName; class?: string }): JSX.Element {
  return (
    <svg
      class={props.class ? `ico ${props.class}` : "ico"}
      viewBox="0 0 24 24"
      aria-hidden="true"
      innerHTML={PATHS[props.name]}
    />
  );
}
