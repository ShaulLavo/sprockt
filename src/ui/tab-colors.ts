// Centralized multicolor tab mapping for editor file tabs, terminal tabs and the landing demo.
// Actual colors live in src/styles.css under `--tab-*` tokens so both themes stay harmonized.

export type TabTone = "ts" | "css" | "json" | "html" | "md" | "shell" | "server" | "task" | "aux" | "default";

const FILE_EXT_TONES: Readonly<Record<string, TabTone>> = {
  ts: "ts",
  tsx: "ts",
  mts: "ts",
  cts: "ts",
  css: "css",
  scss: "css",
  less: "css",
  json: "json",
  jsonc: "json",
  js: "json",
  jsx: "json",
  mjs: "json",
  cjs: "json",
  toml: "json",
  yaml: "json",
  yml: "json",
  lock: "json",
  html: "html",
  htm: "html",
  svelte: "html",
  astro: "html",
  vue: "html",
  svg: "html",
  xml: "html",
  md: "md",
  mdx: "md",
  txt: "md",
};

const TERMINAL_ROLE_TONES: readonly TabTone[] = ["shell", "server", "task", "aux"];

/** Maps a file path to its harmonized tab tone. */
export function fileTabTone(path: string): TabTone {
  const dot = path.lastIndexOf(".");
  if (dot < 0 || dot === path.length - 1) return "default";
  const ext = path.slice(dot + 1).toLowerCase();
  return FILE_EXT_TONES[ext] ?? "default";
}

/** Maps a terminal tab's title and position to its role tone. */
export function terminalTabTone(title: string, index: number): TabTone {
  const lower = title.toLowerCase();
  if (lower.includes("dev") || lower.includes("server") || lower.includes("vite")) return "server";
  if (lower.includes("test") || lower.includes("build") || lower.includes("check")) return "task";
  return TERMINAL_ROLE_TONES[index % TERMINAL_ROLE_TONES.length] ?? "shell";
}
