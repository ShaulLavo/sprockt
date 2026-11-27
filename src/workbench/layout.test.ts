import { describe, expect, test } from "bun:test";
import {
  ariaValue,
  DEFAULT_LAYOUT,
  dragLayout,
  dragTo,
  EDITOR_MIN_PX,
  EDITOR_ROW_MIN_PX,
  fitLayout,
  handleKeyOf,
  keyTo,
  MIN_PX,
  parseLayout,
  serializeLayout,
  STEP_PX,
} from "./layout";

const room = { extent: 1000 };

describe("parseLayout", () => {
  test("round-trips a stored layout", () => {
    const layout = { ...DEFAULT_LAYOUT, explorer: 300, preview: 0.5, terminal: 320, previewOpen: false };
    expect(parseLayout(serializeLayout(layout))).toEqual(layout);
  });

  test("falls back to the default for missing, malformed or hostile input", () => {
    expect(parseLayout(null)).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout("{not json")).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout("42")).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout('{"explorer":"wide","terminalOpen":"yes"}')).toEqual(DEFAULT_LAYOUT);
  });

  test("clamps sizes that would hide or swamp a pane", () => {
    const parsed = parseLayout('{"explorer":2,"preview":7,"terminal":-50}');
    expect(parsed.explorer).toBe(MIN_PX.explorer);
    expect(parsed.preview).toBe(0.9);
    expect(parsed.terminal).toBe(MIN_PX.terminal);
  });
});

describe("dragTo", () => {
  test("resizes within the pane's range", () => {
    expect(dragTo(DEFAULT_LAYOUT, "explorer", 300, room).explorer).toBe(300);
    expect(dragTo(DEFAULT_LAYOUT, "terminal", 400, room).terminal).toBe(400);
    expect(dragTo(DEFAULT_LAYOUT, "preview", 500, room).preview).toBe(0.5);
  });

  test("keeps the editor usable next to the preview and above the terminal", () => {
    expect(dragTo(DEFAULT_LAYOUT, "preview", 990, room).preview).toBe(1 - EDITOR_MIN_PX / 1000);
    expect(dragTo(DEFAULT_LAYOUT, "terminal", 990, room).terminal).toBe(1000 - EDITOR_ROW_MIN_PX);
  });

  test("snaps a pane shut below half its minimum and reopens it when dragged back", () => {
    const closed = dragTo(DEFAULT_LAYOUT, "explorer", 40, room);
    expect(closed.explorerOpen).toBe(false);
    expect(closed.explorer).toBe(DEFAULT_LAYOUT.explorer);
    const reopened = dragTo(closed, "explorer", MIN_PX.explorer / 2 + 1, room);
    expect(reopened.explorerOpen).toBe(true);
    expect(reopened.explorer).toBe(MIN_PX.explorer);
  });
});

describe("keyboard", () => {
  test("arrow keys map to grow and shrink on each handle's own axis", () => {
    expect(handleKeyOf("explorer", "ArrowRight")).toBe("grow");
    expect(handleKeyOf("preview", "ArrowLeft")).toBe("grow");
    expect(handleKeyOf("terminal", "ArrowUp")).toBe("grow");
    expect(handleKeyOf("terminal", "ArrowLeft")).toBeUndefined();
    expect(handleKeyOf("explorer", "Enter")).toBe("toggle");
    expect(handleKeyOf("explorer", "a")).toBeUndefined();
  });

  test("steps, jumps to the ends and toggles", () => {
    expect(keyTo(DEFAULT_LAYOUT, "explorer", "grow", room).explorer).toBe(DEFAULT_LAYOUT.explorer + STEP_PX);
    expect(keyTo(DEFAULT_LAYOUT, "terminal", "shrink", room, true).terminal).toBe(
      DEFAULT_LAYOUT.terminal - 80,
    );
    expect(keyTo(DEFAULT_LAYOUT, "explorer", "min", room).explorer).toBe(MIN_PX.explorer);
    expect(keyTo(DEFAULT_LAYOUT, "preview", "min", room).preview).toBe(MIN_PX.preview / 1000);
    expect(keyTo(DEFAULT_LAYOUT, "preview", "toggle", room).previewOpen).toBe(false);
  });

  test("growing a closed pane opens it at its minimum plus one step", () => {
    const closed = { ...DEFAULT_LAYOUT, terminalOpen: false };
    const grown = keyTo(closed, "terminal", "grow", room);
    expect(grown.terminalOpen).toBe(true);
    expect(grown.terminal).toBe(MIN_PX.terminal + STEP_PX);
  });

  test("reports the size on screen, 0 to 100, to assistive technology", () => {
    const space = { width: 1000, height: 800 };
    const fitted = fitLayout(DEFAULT_LAYOUT, space);
    expect(ariaValue(fitted, "preview", space)).toBe(Math.round(DEFAULT_LAYOUT.preview * 100));
    expect(ariaValue({ ...fitted, terminal: 0 }, "terminal", space)).toBe(0);
    // A wide saved explorer held narrower by a small window reports what is shown.
    const narrow = { width: 736, height: 700 };
    const held = fitLayout({ ...DEFAULT_LAYOUT, explorer: 520 }, narrow);
    expect(ariaValue(held, "explorer", narrow)).toBeLessThan(100);
  });

  test("an arrow key steps from the size on screen when the window holds the pane smaller", () => {
    const wide = { ...DEFAULT_LAYOUT, explorer: 520 };
    expect(keyTo(wide, "explorer", "shrink", room, false, 200).explorer).toBe(200 - STEP_PX);
  });
});

describe("dragLayout", () => {
  const gesture = { startLayout: DEFAULT_LAYOUT, startPx: 420, room };

  test("follows the pointer, and snaps the pane shut past half its minimum", () => {
    expect(dragLayout("preview", { ...gesture, growth: 80 }).preview).toBe(0.5);
    expect(dragLayout("preview", { ...gesture, growth: -400 }).previewOpen).toBe(false);
  });

  test("a drag back to within the click threshold of the press restores where it started", () => {
    expect(dragLayout("preview", { ...gesture, growth: 1 })).toBe(DEFAULT_LAYOUT);
    expect(dragLayout("preview", { ...gesture, growth: -2 })).toBe(DEFAULT_LAYOUT);
  });
});

describe("fitLayout", () => {
  test("a layout that fits renders as saved", () => {
    expect(fitLayout(DEFAULT_LAYOUT, { width: 1376, height: 828 })).toEqual({
      explorer: DEFAULT_LAYOUT.explorer,
      preview: Math.round(DEFAULT_LAYOUT.preview * (1376 - DEFAULT_LAYOUT.explorer)),
      terminal: DEFAULT_LAYOUT.terminal,
    });
  });

  test("a wide explorer saved at 1440px leaves the editor its minimum at 800px", () => {
    const wide = { ...DEFAULT_LAYOUT, explorer: 480 };
    // 800px window: minus the activity bar and three 6px gaps.
    const fitted = fitLayout(wide, { width: 736, height: 700 });
    const editor = 736 - fitted.explorer - fitted.preview;
    expect(editor).toBeGreaterThanOrEqual(EDITOR_MIN_PX);
    expect(fitted.preview).toBeGreaterThanOrEqual(MIN_PX.preview);
    expect(fitted.explorer).toBeGreaterThanOrEqual(MIN_PX.explorer);
    // The saved layout is untouched, so the explorer grows back with the window.
    expect(fitLayout(wide, { width: 1376, height: 700 }).explorer).toBe(480);
  });

  test("when even the minimums do not fit, the editor keeps its width first", () => {
    const fitted = fitLayout(DEFAULT_LAYOUT, { width: 600, height: 400 });
    expect(600 - fitted.explorer - fitted.preview).toBeGreaterThanOrEqual(EDITOR_MIN_PX);
    expect(400 - fitted.terminal).toBeGreaterThanOrEqual(EDITOR_ROW_MIN_PX);
  });

  test("closed panes take no space", () => {
    const closed = { ...DEFAULT_LAYOUT, explorerOpen: false, previewOpen: false, terminalOpen: false };
    expect(fitLayout(closed, { width: 1000, height: 800 })).toEqual({ explorer: 0, preview: 0, terminal: 0 });
  });
});
