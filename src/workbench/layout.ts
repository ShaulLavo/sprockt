// The desktop pane layout as plain data: sizes, which panes are open, and the arithmetic that
// drag handles and keyboard handles share. No Solid and no DOM here, so it is unit tested.

import { LAYOUT_LIMITS } from "@shaulavo/workbench-core";

/** A drag handle between two panes, named after the pane it resizes. */
export type Splitter = "explorer" | "preview" | "terminal";

export interface PaneLayout {
  /** Explorer width in CSS pixels. */
  readonly explorer: number;
  /** Preview share of the editor and preview row, from 0 to 1. */
  readonly preview: number;
  /** Terminal panel height in CSS pixels. */
  readonly terminal: number;
  readonly explorerOpen: boolean;
  readonly previewOpen: boolean;
  readonly terminalOpen: boolean;
}

export const DEFAULT_LAYOUT: PaneLayout = {
  explorer: 232,
  preview: 0.36,
  terminal: 236,
  explorerOpen: true,
  previewOpen: true,
  terminalOpen: true,
};

/** Smallest sizes a pane may be dragged to, in CSS pixels. Below half of it the pane closes. */
export const MIN_PX: Readonly<Record<Splitter, number>> = {
  explorer: LAYOUT_LIMITS.explorerMinPx,
  preview: LAYOUT_LIMITS.previewMinPx,
  terminal: LAYOUT_LIMITS.terminalMinPx,
};
/** The editor always keeps this much width next to an open preview. */
export const EDITOR_MIN_PX = LAYOUT_LIMITS.editorMinPx;
/** The editor row always keeps this much height above an open terminal. */
export const EDITOR_ROW_MIN_PX = LAYOUT_LIMITS.codeAreaMinPx;
const EXPLORER_MAX_PX = LAYOUT_LIMITS.explorerMaxPx;

/** Keyboard steps: arrow keys move a handle by STEP_PX, with Shift by BIG_STEP_PX. */
export const STEP_PX = 16;
export const BIG_STEP_PX = 80;

const OPEN_KEY: Readonly<Record<Splitter, "explorerOpen" | "previewOpen" | "terminalOpen">> = {
  explorer: "explorerOpen",
  preview: "previewOpen",
  terminal: "terminalOpen",
};

export const GLOBAL_LAYOUT_KEY = "sprockt:layout:v1";

/** Legacy per-workspace key, kept only for one-way migration into GLOBAL_LAYOUT_KEY. */
export const layoutStorageKey = (workspaceId: string) => `sprockt:layout:${workspaceId}`;

export function isOpen(layout: PaneLayout, splitter: Splitter): boolean {
  return layout[OPEN_KEY[splitter]];
}

export function setOpen(layout: PaneLayout, splitter: Splitter, open: boolean): PaneLayout {
  return { ...layout, [OPEN_KEY[splitter]]: open };
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));
const finite = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
const flag = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);

/** Reads a stored layout. Anything missing, malformed or out of range falls back to the default. */
export function parseLayout(text: string | null | undefined): PaneLayout {
  if (!text) return DEFAULT_LAYOUT;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return DEFAULT_LAYOUT;
  }
  if (typeof raw !== "object" || raw === null) return DEFAULT_LAYOUT;
  const value = raw as Record<string, unknown>;
  return {
    explorer: clamp(finite(value.explorer, DEFAULT_LAYOUT.explorer), MIN_PX.explorer, EXPLORER_MAX_PX),
    preview: clamp(finite(value.preview, DEFAULT_LAYOUT.preview), 0.1, 0.9),
    terminal: Math.max(finite(value.terminal, DEFAULT_LAYOUT.terminal), MIN_PX.terminal),
    explorerOpen: flag(value.explorerOpen, true),
    previewOpen: flag(value.previewOpen, true),
    terminalOpen: flag(value.terminalOpen, true),
  };
}

export const serializeLayout = (layout: PaneLayout) => JSON.stringify(layout);

/**
 * How much room a handle has, measured once when a drag or key press starts: `extent` is the
 * width of the editor and preview row (preview), or the height of the column the terminal
 * shares with the editor row (terminal). The explorer ignores it.
 */
export interface Room {
  readonly extent: number;
}

/** The size range a pane may take in the given room, in its own unit. */
export function sizeRange(splitter: Splitter, room: Room): { min: number; max: number } {
  if (splitter === "explorer") return { min: MIN_PX.explorer, max: EXPLORER_MAX_PX };
  if (splitter === "terminal") return { min: MIN_PX.terminal, max: room.extent - EDITOR_ROW_MIN_PX };
  const extent = Math.max(room.extent, 1);
  return { min: MIN_PX.preview / extent, max: 1 - EDITOR_MIN_PX / extent };
}

/** The current size of a pane in CSS pixels. */
export function sizePx(layout: PaneLayout, splitter: Splitter, room: Room): number {
  if (splitter === "preview") return layout.preview * room.extent;
  return layout[splitter];
}

function withSizePx(layout: PaneLayout, splitter: Splitter, px: number, room: Room): PaneLayout {
  const range = sizeRange(splitter, room);
  const value = splitter === "preview" ? px / Math.max(room.extent, 1) : px;
  return { ...setOpen(layout, splitter, true), [splitter]: clamp(value, range.min, range.max) };
}

/**
 * The layout while a handle is dragged to make its pane `px` wide or tall. Dragging below half
 * the minimum closes the pane, the way most editors snap a sidebar shut; dragging back out
 * opens it again at the minimum.
 */
export function dragTo(layout: PaneLayout, splitter: Splitter, px: number, room: Room): PaneLayout {
  if (px < MIN_PX[splitter] / 2) return setOpen(layout, splitter, false);
  return withSizePx(layout, splitter, px, room);
}

/** A pointer that moved less than this from where it was pressed is a click, not a drag. */
export const DRAG_THRESHOLD_PX = 3;

/** One drag of a handle, from the press to where the pointer is now (CSS pixels, signed). */
export interface DragGesture {
  readonly startLayout: PaneLayout;
  /** The pane's size on screen at the press; 0 when it was closed. */
  readonly startPx: number;
  /** How far the pointer has moved toward growing the pane since the press. */
  readonly growth: number;
  readonly room: Room;
}

/**
 * The layout a drag shows. It depends only on the press and the pointer now, so a drag that
 * snaps a pane shut and comes back to where it started restores the layout it started from.
 */
export function dragLayout(splitter: Splitter, gesture: DragGesture): PaneLayout {
  if (Math.abs(gesture.growth) < DRAG_THRESHOLD_PX) return gesture.startLayout;
  return dragTo(gesture.startLayout, splitter, gesture.startPx + gesture.growth, gesture.room);
}

export type HandleKey = "grow" | "shrink" | "min" | "max" | "toggle";

/** Keyboard control of a handle, following the WAI-ARIA window splitter pattern. */
export function keyTo(
  layout: PaneLayout,
  splitter: Splitter,
  key: HandleKey,
  room: Room,
  big = false,
  /** The pane's size on screen, when a narrow window holds it below the saved size. */
  shown?: number,
): PaneLayout {
  if (key === "toggle") return setOpen(layout, splitter, !isOpen(layout, splitter));
  const range = sizeRange(splitter, room);
  const toPx = (value: number) => (splitter === "preview" ? value * room.extent : value);
  if (key === "min") return withSizePx(layout, splitter, toPx(range.min), room);
  if (key === "max") return withSizePx(layout, splitter, toPx(range.max), room);
  const saved = shown ?? sizePx(layout, splitter, room);
  const current = isOpen(layout, splitter) ? saved : MIN_PX[splitter];
  const step = (big ? BIG_STEP_PX : STEP_PX) * (key === "grow" ? 1 : -1);
  return withSizePx(layout, splitter, current + step, room);
}

/** Which direction a key moves a handle: the explorer grows rightward, the others toward the editor. */
export function handleKeyOf(splitter: Splitter, key: string): HandleKey | undefined {
  if (key === "Enter") return "toggle";
  if (key === "Home") return "min";
  if (key === "End") return "max";
  if (key === GROW_KEY[splitter]) return "grow";
  if (key === SHRINK_KEY[splitter]) return "shrink";
  // Cross-axis arrows and everything else keep their usual meaning for the page.
  return undefined;
}

const GROW_KEY: Readonly<Record<Splitter, string>> = {
  explorer: "ArrowRight",
  preview: "ArrowLeft",
  terminal: "ArrowUp",
};
const SHRINK_KEY: Readonly<Record<Splitter, string>> = {
  explorer: "ArrowLeft",
  preview: "ArrowRight",
  terminal: "ArrowDown",
};

const share = (size: number, extent: number) => Math.round(Math.min(size / Math.max(extent, 1), 1) * 100);

/**
 * The value a handle reports to assistive technology, 0 to 100, from what is on screen: the
 * explorer against its widest, the preview against the row it shares with the editor, the
 * terminal against the column it shares with the editor row.
 */
export function ariaValue(fitted: Fitted, splitter: Splitter, space: Space): number {
  if (splitter === "explorer") return share(fitted.explorer, EXPLORER_MAX_PX);
  if (splitter === "preview") return share(fitted.preview, space.width - fitted.explorer);
  return share(fitted.terminal, space.height);
}

/** The space the panes share: the width of Explorer, Editor and Preview, and the height of the editor row and the terminal. */
export interface Space {
  readonly width: number;
  readonly height: number;
}

/** What is rendered, in CSS pixels. A closed pane is 0 (the terminal keeps its tab strip in CSS). */
export interface Fitted {
  readonly explorer: number;
  readonly preview: number;
  readonly terminal: number;
}

const atLeast = (value: number, floor: number) => Math.max(value, floor);

/**
 * Fits a saved layout into the space there is. The editor keeps priority: when everything
 * cannot fit, the explorer and preview give up width first, down to their minimums and then
 * below, and the terminal gives up height. The saved layout is not changed, so the panes grow
 * back when the window does.
 */
export function fitLayout(layout: PaneLayout, space: Space): Fitted {
  const spare = atLeast(space.width - EDITOR_MIN_PX, 0);
  const previewReserve = layout.previewOpen ? MIN_PX.preview : 0;
  const explorerRoom = Math.min(atLeast(spare - previewReserve, MIN_PX.explorer), spare);
  const explorer = layout.explorerOpen ? Math.min(layout.explorer, explorerRoom) : 0;
  const area = space.width - explorer;
  const previewMax = atLeast(area - EDITOR_MIN_PX, 0);
  const previewMin = Math.min(MIN_PX.preview, previewMax);
  const preview = layout.previewOpen ? clamp(layout.preview * area, previewMin, previewMax) : 0;
  const terminalMax = atLeast(space.height - EDITOR_ROW_MIN_PX, 0);
  const terminal = layout.terminalOpen ? Math.min(layout.terminal, terminalMax) : 0;
  return { explorer: Math.round(explorer), preview: Math.round(preview), terminal: Math.round(terminal) };
}
