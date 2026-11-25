const BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "json",
  css: "css",
  html: "html",
  md: "markdown",
  svelte: "svelte",
  astro: "astro",
  vue: "vue",
  sh: "shellscript",
  toml: "toml",
  yaml: "yaml",
  yml: "yaml",
};

/** The editor language id for a file path, or null when the extension is not one we know. */
export function languageOf(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null;
}
