import { describe, expect, test } from "bun:test";
import { parseCssColor, terminalTheme, xtermPalette } from "./theme";

describe("terminal theme", () => {
  test("parses the color formats browsers compute", () => {
    expect(parseCssColor("rgb(16, 22, 30)")).toEqual({ r: 16, g: 22, b: 30 });
    expect(parseCssColor("rgba(255, 92, 138, 0.5)")).toEqual({ r: 255, g: 92, b: 138 });
    expect(parseCssColor("rgb(1 2 3 / 50%)")).toEqual({ r: 1, g: 2, b: 3 });
    expect(parseCssColor("color(srgb 1 0.5 0)")).toEqual({ r: 255, g: 128, b: 0 });
    expect(parseCssColor("light-dark(#fff, #000)")).toBeUndefined();
  });

  test("builds the 256-color palette around the given 16", () => {
    const ansi = Array.from({ length: 16 }, (_, index) => ({ r: index, g: index, b: index }));
    const palette = xtermPalette(ansi);
    expect(palette).toHaveLength(256);
    expect(palette[15]).toEqual({ r: 15, g: 15, b: 15 });
    expect(palette[16]).toEqual({ r: 0, g: 0, b: 0 });
    expect(palette[196]).toEqual({ r: 255, g: 0, b: 0 });
    expect(palette[231]).toEqual({ r: 255, g: 255, b: 255 });
    expect(palette[232]).toEqual({ r: 8, g: 8, b: 8 });
    expect(palette[255]).toEqual({ r: 238, g: 238, b: 238 });
  });

  test("draws the cursor's character in the background color", () => {
    const color = { r: 1, g: 2, b: 3 };
    const theme = terminalTheme({
      background: color,
      foreground: color,
      cursor: color,
      selectionBackground: color,
      selectionForeground: color,
      ansi: Array.from({ length: 16 }, () => color),
    });
    expect(theme.cursorText).toEqual(color);
    expect(theme.palette).toHaveLength(256);
  });
});
