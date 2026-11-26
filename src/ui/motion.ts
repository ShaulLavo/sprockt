// Centralized motion constants (emil-design-eng curves and durations, plus landing demo cadence).
// CSS mirrors the same durations and curves via `--dur-*` and `--ease-*` in src/styles.css.

export const MOTION = {
  /** Tactile press and subtle color transitions. */
  fastMs: 120,
  /** Popovers, tab indicators, save tick and focus states. */
  baseMs: 160,
  /** Modals, drawers and preview refresh entrance. */
  slowMs: 240,
  /** One-shot hero entrance. */
  enterMs: 460,
  /** Strong ease-out for entering elements and direct UI responses. */
  easeOut: "cubic-bezier(0.23, 1, 0.32, 1)",
  /** Strong ease-in-out for on-screen movement. */
  easeInOut: "cubic-bezier(0.77, 0, 0.175, 1)",
  /** Drawer / sheet glide curve. */
  easeDrawer: "cubic-bezier(0.32, 0.72, 0, 1)",
} as const;

/**
 * Scripted sequence for the live landing workbench demo.
 * Every visible line is real Vite + React starter output (Bun 1.4.5, Vite 7.3.8).
 */
export const DEMO_SEQUENCE = {
  /** Typing speed per character in the terminal prompt (ms). */
  typeCharMs: 36,
  /** Timeline offsets (ms from sequence start) for each milestone. */
  installStartMs: 320,
  installOutputMs: 920,
  devStartMs: 1620,
  devReadyMs: 2300,
  /** Live edit + save + HMR beat after server is ready. */
  editHighlightMs: 3200,
  saveTickMs: 3900,
  hmrFlashMs: 4300,
  /** How long the HMR flash ring stays visible. */
  hmrDurationMs: 650,
} as const;
