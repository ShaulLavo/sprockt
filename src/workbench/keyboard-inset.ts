// Tracks the mobile soft-keyboard height via `window.visualViewport` and publishes it as
// `--keyboard-inset` + `data-keyboard-open` on the workbench root, preventing iOS Safari from
// covering the bottom terminal keys bar or scrolling the document off-screen.
import { useEffect, type RefObject } from "react";

const KEYBOARD_OPEN_THRESHOLD_PX = 80;

export function useKeyboardInset(rootRef: RefObject<HTMLElement | null>, enabled: boolean): void {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (!enabled || !window.visualViewport) {
      root.style.removeProperty("--keyboard-inset");
      delete root.dataset.keyboardOpen;
      return;
    }
    const viewport = window.visualViewport;
    const update = () => {
      const inset = Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop));
      root.style.setProperty("--keyboard-inset", `${inset}px`);
      if (inset > KEYBOARD_OPEN_THRESHOLD_PX) {
        root.dataset.keyboardOpen = "true";
        if (window.scrollY !== 0) window.scrollTo(0, 0);
      } else {
        delete root.dataset.keyboardOpen;
      }
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      root.style.removeProperty("--keyboard-inset");
      delete root.dataset.keyboardOpen;
    };
  }, [rootRef, enabled]);
}
