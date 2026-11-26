// Clean MIT touch long-press context-menu synthesizer for iOS/touch devices. Dispatches a
// synthetic `contextmenu` event after a stationary 550ms touch press on non-selectable UI targets
// (tree rows, tabs, terminal surface), while preserving native text selection inside editors/inputs.
import { useEffect, type RefObject } from "react";

const LONG_PRESS_MS = 550;
const MOVE_TOLERANCE_PX = 10;
const NATIVE_DEDUP_MS = 700;

function isSelectableTextTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest("input, textarea, [contenteditable='true'], .editor-host")) return true;
  const style = getComputedStyle(target);
  return style.userSelect === "text" || style.webkitUserSelect === "text";
}

export function useLongPressContextMenu(rootRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let startX = 0;
    let startY = 0;
    let pressTarget: Element | null = null;
    let pointerId: number | undefined;
    let suppressNextClick = false;
    let lastSynthesizedAt = 0;

    function cancel(): void {
      clearTimeout(timer);
      timer = undefined;
      pressTarget = null;
      pointerId = undefined;
    }

    function onPointerDown(event: PointerEvent): void {
      if (event.pointerType !== "touch" || !event.isPrimary) return;
      if (isSelectableTextTarget(event.target)) return;
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      cancel();
      startX = event.clientX;
      startY = event.clientY;
      pressTarget = target;
      pointerId = event.pointerId;
      timer = setTimeout(() => {
        timer = undefined;
        if (!pressTarget || !pressTarget.isConnected) return;
        suppressNextClick = true;
        lastSynthesizedAt = Date.now();
        pressTarget.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: startX,
            clientY: startY,
            button: 2,
          }),
        );
        pressTarget = null;
        pointerId = undefined;
      }, LONG_PRESS_MS);
    }

    function onPointerMove(event: PointerEvent): void {
      if (pointerId === undefined || event.pointerId !== pointerId) return;
      if (Math.hypot(event.clientX - startX, event.clientY - startY) > MOVE_TOLERANCE_PX) cancel();
    }

    function onPointerEnd(event: PointerEvent): void {
      if (pointerId !== undefined && event.pointerId === pointerId) cancel();
    }

    function onClickCapture(event: MouseEvent): void {
      if (!suppressNextClick) return;
      suppressNextClick = false;
      event.preventDefault();
      event.stopPropagation();
    }

    function onContextMenuCapture(event: MouseEvent): void {
      if (event.isTrusted && Date.now() - lastSynthesizedAt < NATIVE_DEDUP_MS) {
        event.preventDefault();
        event.stopPropagation();
      }
    }

    root.addEventListener("pointerdown", onPointerDown, true);
    root.addEventListener("pointermove", onPointerMove, true);
    root.addEventListener("pointerup", onPointerEnd, true);
    root.addEventListener("pointercancel", onPointerEnd, true);
    root.addEventListener("scroll", cancel, true);
    root.addEventListener("click", onClickCapture, true);
    root.addEventListener("contextmenu", onContextMenuCapture, true);
    return () => {
      cancel();
      root.removeEventListener("pointerdown", onPointerDown, true);
      root.removeEventListener("pointermove", onPointerMove, true);
      root.removeEventListener("pointerup", onPointerEnd, true);
      root.removeEventListener("pointercancel", onPointerEnd, true);
      root.removeEventListener("scroll", cancel, true);
      root.removeEventListener("click", onClickCapture, true);
      root.removeEventListener("contextmenu", onContextMenuCapture, true);
    };
  }, [rootRef]);
}
