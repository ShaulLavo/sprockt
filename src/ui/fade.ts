// Soft edges for horizontal scrollers (tab strips, key rows). An edge fades only while there is
// more content past it, so a strip that fits shows no fade at all. The CSS lives with
// `[data-fade]` in src/styles.css.

/** Which edges have content past them, given a scroller's measurements. */
export function fadeEdges(scrollLeft: number, scrollWidth: number, clientWidth: number): string {
  const start = scrollLeft > 1;
  const end = scrollLeft + clientWidth < scrollWidth - 1;
  return [start ? "start" : "", end ? "end" : ""].filter(Boolean).join(" ");
}

/** Keeps `data-fade` on `element` current as it scrolls, resizes or gains children. */
export function trackOverflowFade(element: HTMLElement): () => void {
  let frame = 0;
  const update = () => {
    frame = 0;
    element.dataset.fade = fadeEdges(element.scrollLeft, element.scrollWidth, element.clientWidth);
  };
  const schedule = () => {
    frame ||= requestAnimationFrame(update);
  };
  const resize = new ResizeObserver(schedule);
  resize.observe(element);
  const children = new MutationObserver(schedule);
  children.observe(element, { childList: true, subtree: true, characterData: true });
  element.addEventListener("scroll", schedule, { passive: true });
  schedule();
  return () => {
    cancelAnimationFrame(frame);
    resize.disconnect();
    children.disconnect();
    element.removeEventListener("scroll", schedule);
  };
}
