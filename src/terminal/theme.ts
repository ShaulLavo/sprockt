// The terminal's colors come from the same design tokens as the rest of the workbench
// (src/styles.css), resolved for the current theme. The parsing and palette math are pure; only
// `readTerminalColors` touches the DOM.
import type { TerminalColor, TerminalColorScheme, TerminalFontSettings, TerminalTheme } from "ghostty-webgpu";

/** The 16 ANSI colors in order: black, red, green, yellow, blue, magenta, cyan, white, then bright. */
export const ANSI_TOKENS = [
  "--ansi-black",
  "--ansi-red",
  "--ansi-green",
  "--ansi-yellow",
  "--ansi-blue",
  "--ansi-magenta",
  "--ansi-cyan",
  "--ansi-white",
  "--ansi-bright-black",
  "--ansi-bright-red",
  "--ansi-bright-green",
  "--ansi-bright-yellow",
  "--ansi-bright-blue",
  "--ansi-bright-magenta",
  "--ansi-bright-cyan",
  "--ansi-bright-white",
] as const;

export const SURFACE_TOKENS = {
  background: "--term-bg",
  foreground: "--ansi-fg",
  cursor: "--term-cursor",
  selectionBackground: "--bg-selection",
  selectionForeground: "--fg",
} as const;

type SurfaceKey = keyof typeof SURFACE_TOKENS;
export type TerminalColors = Readonly<Record<SurfaceKey, TerminalColor>> & {
  readonly ansi: readonly TerminalColor[];
};

/** Matches the phone layout in workbench.css. A phone gets a size that fits about 50 columns. */
export function isPhoneViewport(): boolean {
  return typeof matchMedia === "function" && matchMedia("(max-width: 768px)").matches;
}

const FONT_FAMILY =
  '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace';

/** Returns the terminal font settings for the current (or given) phone/desktop breakpoint. */
export function terminalFont(phone = isPhoneViewport()): Partial<TerminalFontSettings> {
  return {
    family: FONT_FAMILY,
    size: phone ? 12 : 13,
    lineHeight: 1.15,
    weight: 400,
    boldWeight: 600,
  };
}

/** The terminal font: the workbench's code face, with the platform monospace as a fallback. */
export const TERMINAL_FONT: Partial<TerminalFontSettings> = terminalFont();

const channel = (text: string) => Math.round(Math.min(Math.max(Number(text), 0), 255));

/** Parses a computed CSS color: `rgb(r, g, b)`, `rgb(r g b / a)` or `color(srgb r g b)`. */
export function parseCssColor(value: string): TerminalColor | undefined {
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(value.trim());
  if (rgb?.[1] && rgb[2] && rgb[3]) return { r: channel(rgb[1]), g: channel(rgb[2]), b: channel(rgb[3]) };
  const srgb = /^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/i.exec(value.trim());
  if (srgb?.[1] && srgb[2] && srgb[3]) {
    const scale = (text: string) => channel(String(Number(text) * 255));
    return { r: scale(srgb[1]), g: scale(srgb[2]), b: scale(srgb[3]) };
  }
  return undefined;
}

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255] as const;

/** The xterm 256-color palette: the given 16, the 6x6x6 color cube, then 24 greys. */
export function xtermPalette(ansi: readonly TerminalColor[]): TerminalColor[] {
  const cube = Array.from({ length: 216 }, (_, index) => ({
    r: CUBE_LEVELS[Math.floor(index / 36)] ?? 0,
    g: CUBE_LEVELS[Math.floor(index / 6) % 6] ?? 0,
    b: CUBE_LEVELS[index % 6] ?? 0,
  }));
  const greys = Array.from({ length: 24 }, (_, index) => {
    const level = 8 + index * 10;
    return { r: level, g: level, b: level };
  });
  return ansi.slice(0, 16).concat(cube, greys);
}

export function terminalTheme(colors: TerminalColors): TerminalTheme {
  return {
    background: colors.background,
    foreground: colors.foreground,
    cursor: colors.cursor,
    cursorText: colors.background,
    selectionBackground: colors.selectionBackground,
    selectionForeground: colors.selectionForeground,
    minimumContrast: 1,
    palette: xtermPalette(colors.ansi),
  };
}

const BLACK: TerminalColor = { r: 0, g: 0, b: 0 };

/**
 * Resolves the terminal tokens for `scheme` (or the theme currently in effect on the document).
 * Mounts a hidden (non-`display: none`) probe on `<body>`/`<html>` rather than inside `element`
 * because a hidden terminal pane (`display: none`, e.g. on phones) skips style recalculation in
 * WebKit/Safari and would otherwise return stale `light-dark()` colors after a theme toggle.
 */
export function readTerminalColors(element: HTMLElement, scheme?: TerminalColorScheme): TerminalColors {
  const doc = element.ownerDocument;
  const probe = doc.createElement("span");
  probe.style.cssText =
    "position:fixed;visibility:hidden;pointer-events:none;width:0;height:0;overflow:hidden;";
  if (scheme) probe.style.colorScheme = scheme;
  (doc.body ?? doc.documentElement).append(probe);
  const style = getComputedStyle(probe);
  const read = (token: string) => {
    probe.style.color = `var(${token})`;
    return parseCssColor(style.color) ?? BLACK;
  };
  const surface = Object.fromEntries(
    Object.entries(SURFACE_TOKENS).map(([key, token]) => [key, read(token)]),
  ) as Record<SurfaceKey, TerminalColor>;
  const ansi = ANSI_TOKENS.map(read);
  probe.remove();
  return { ...surface, ansi };
}

export function terminalAppearance(
  element: HTMLElement,
  scheme: TerminalColorScheme,
  phone = isPhoneViewport(),
) {
  return {
    colorScheme: scheme,
    theme: terminalTheme(readTerminalColors(element, scheme)),
    font: terminalFont(phone),
  };
}
