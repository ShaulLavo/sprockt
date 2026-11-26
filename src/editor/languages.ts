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
  // No Vue grammar in Singapore yet: its HTML grammar colours the template and, through
  // injections, the <script> and <style> blocks.
  vue: "html",
  htm: "html",
  markdown: "markdown",
  mdx: "mdx",
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

/** What the status bar calls a file's language, by extension. */
const NAME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: "TypeScript",
  mts: "TypeScript",
  cts: "TypeScript",
  tsx: "TypeScript JSX",
  js: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  jsx: "JavaScript JSX",
  json: "JSON",
  jsonc: "JSON with Comments",
  css: "CSS",
  html: "HTML",
  htm: "HTML",
  md: "Markdown",
  markdown: "Markdown",
  mdx: "MDX",
  svelte: "Svelte",
  astro: "Astro",
  vue: "Vue",
  sh: "Shell",
  toml: "TOML",
  yaml: "YAML",
  yml: "YAML",
};

/** The language name to show for a file: its known language, else plain text. */
export function languageName(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const known = dot > 0 ? NAME_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] : undefined;
  return known ?? "Plain Text";
}
