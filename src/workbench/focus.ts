// Lightweight pane focus coordination for desktop shortcuts and overlay dismissal.
import type { PhonePane } from "./PaneSwitcher";

/** Moves keyboard focus to the primary interactive target inside a workbench pane slot. */
export function focusPane(pane: PhonePane): boolean {
  const slot = document.getElementById(`wb-slot-${pane}`);
  if (!slot) return false;
  if (pane === "code") {
    const target = slot.querySelector<HTMLElement>(
      ".editor-host textarea, .editor-host [contenteditable='true'], .editor-host [tabindex]",
    );
    if (target) {
      target.focus();
      return true;
    }
  }
  if (pane === "terminal") {
    const target = slot.querySelector<HTMLElement>(
      '.term-view:not([data-position="hidden"]) textarea, .terminal-host button, [data-testid="terminal-tab"]',
    );
    if (target) {
      target.focus();
      return true;
    }
  }
  if (pane === "files") {
    const target = slot.querySelector<HTMLElement>(
      '[data-wb-tree-row][tabindex="0"], [data-wb-tree-row], [data-testid="new-file"]',
    );
    if (target) {
      target.focus();
      return true;
    }
  }
  const fallback = slot.querySelector<HTMLElement>(
    "button:not(:disabled), input:not(:disabled), iframe, [tabindex='0']",
  );
  if (!fallback) return false;
  fallback.focus();
  return true;
}
