import { describe, expect, test } from "bun:test";
import { isTouchOrMobile, shouldAutoFocusEditor, type MediaMatcher } from "./focus-policy";

function matcher(matches: Readonly<Record<string, boolean>>): MediaMatcher {
  return (query) => ({ matches: Boolean(matches[query]) });
}

describe("editor focus policy", () => {
  test("never auto-focuses for touch pointers, even on wide screens", () => {
    const desktop = matcher({ "(pointer: coarse)": false, "(max-width: 768px)": false });
    expect(isTouchOrMobile("touch", desktop)).toBe(true);
    expect(shouldAutoFocusEditor("touch", desktop)).toBe(false);
  });

  test("never auto-focuses for pointer taps on coarse-pointer or phone-width viewports", () => {
    const coarse = matcher({ "(pointer: coarse)": true, "(max-width: 768px)": false });
    const narrow = matcher({ "(pointer: coarse)": false, "(max-width: 768px)": true });
    expect(shouldAutoFocusEditor("mouse", coarse)).toBe(false);
    expect(shouldAutoFocusEditor(undefined, narrow)).toBe(false);
  });

  test("auto-focuses on explicit keyboard activation even on hybrid touch devices", () => {
    const hybrid = matcher({ "(pointer: coarse)": true, "(max-width: 768px)": false });
    expect(shouldAutoFocusEditor("keyboard", hybrid)).toBe(true);
  });

  test("auto-focuses on desktop mouse and keyboard navigation", () => {
    const desktop = matcher({ "(pointer: coarse)": false, "(max-width: 768px)": false });
    expect(shouldAutoFocusEditor("mouse", desktop)).toBe(true);
    expect(shouldAutoFocusEditor(undefined, desktop)).toBe(true);
  });
});
