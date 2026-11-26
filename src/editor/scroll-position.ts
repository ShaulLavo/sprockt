// Pure scroll and tab-strip geometry helpers for the editor pane.
import type { EditorScrollPosition } from "@singapore-editor/core";

/**
 * Clamps a restored vertical scroll offset so switching back to a tab with `scrollPastEnd` on
 * never strands the viewport inside blank overscroll space below the last line.
 */
export function capOverscrollTop(savedTop: number, contentHeight: number, clientHeight: number): number {
  if (!Number.isFinite(savedTop) || savedTop <= 0) return 0;
  if (!Number.isFinite(contentHeight) || !Number.isFinite(clientHeight) || clientHeight <= 0) {
    return savedTop;
  }
  const maxTop = Math.max(0, contentHeight - clientHeight);
  return Math.min(savedTop, maxTop);
}

/** Clamps a stored scroll position for `attachSession`. */
export function clampRestoredScroll(
  saved: EditorScrollPosition | undefined,
  contentHeight: number,
  clientHeight: number,
): EditorScrollPosition | undefined {
  if (!saved) return undefined;
  return {
    top: saved.top === undefined ? undefined : capOverscrollTop(saved.top, contentHeight, clientHeight),
    left: saved.left,
  };
}

/**
 * Computes the minimal horizontal `scrollLeft` needed for `tab` to sit inside `strip`, clearing
 * `gutter` pixels on each edge (for the overflow fade). A tab wider than the strip aligns left.
 */
export function minimalTabScrollLeft(params: {
  readonly scrollLeft: number;
  readonly clientWidth: number;
  readonly tabLeft: number;
  readonly tabWidth: number;
  readonly gutter?: number;
}): number {
  const { scrollLeft, clientWidth, tabLeft, tabWidth } = params;
  const gutter = params.gutter ?? 28;
  if (clientWidth <= 0) return scrollLeft;
  const tabRight = tabLeft + tabWidth;
  if (tabWidth >= clientWidth - gutter * 2) return Math.max(0, tabLeft - gutter);
  const visibleStart = scrollLeft + gutter;
  const visibleEnd = scrollLeft + clientWidth - gutter;
  if (tabLeft < visibleStart) return Math.max(0, tabLeft - gutter);
  if (tabRight > visibleEnd) return Math.max(0, tabRight - clientWidth + gutter);
  return scrollLeft;
}

/** Smoothly (or instantly under reduced motion) reveals `tab` inside `strip` with minimal movement. */
export function revealTabInStrip(strip: HTMLElement, tab: HTMLElement, gutter = 28): void {
  const stripRect = strip.getBoundingClientRect();
  const tabRect = tab.getBoundingClientRect();
  const tabLeft = tabRect.left - stripRect.left + strip.scrollLeft;
  const nextLeft = minimalTabScrollLeft({
    scrollLeft: strip.scrollLeft,
    clientWidth: strip.clientWidth,
    tabLeft,
    tabWidth: tabRect.width,
    gutter,
  });
  if (Math.abs(nextLeft - strip.scrollLeft) < 1) return;
  const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  strip.scrollTo({ left: nextLeft, behavior: reduced ? "auto" : "smooth" });
}
