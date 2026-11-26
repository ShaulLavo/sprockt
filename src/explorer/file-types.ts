// Which icon and colour a file gets. Supports multi-dot conventions (`.test.ts`, `.d.ts`,
// `.config.ts`) and well-known filenames (`Dockerfile`, `Makefile`, `LICENSE`) using clean MIT
// stroke glyphs from `./icons.tsx`.
export type FileIcon =
  | "file"
  | "typescript"
  | "javascript"
  | "react"
  | "test"
  | "braces"
  | "hash"
  | "markup"
  | "markdown"
  | "lock"
  | "settings"
  | "shell"
  | "image";

/** The tone class (`ft-*`) that colours the icon, from Sprockt's file-type tokens. */
export type FileTone =
  | "ft-ts"
  | "ft-js"
  | "ft-json"
  | "ft-css"
  | "ft-html"
  | "ft-md"
  | "ft-lock"
  | "ft-image"
  | "ft-test"
  | "";

export interface FileKind {
  readonly icon: FileIcon;
  readonly tone: FileTone;
}

const BY_EXTENSION: Readonly<Record<string, FileKind>> = {
  ts: { icon: "typescript", tone: "ft-ts" },
  mts: { icon: "typescript", tone: "ft-ts" },
  cts: { icon: "typescript", tone: "ft-ts" },
  tsx: { icon: "react", tone: "ft-ts" },
  jsx: { icon: "react", tone: "ft-js" },
  js: { icon: "javascript", tone: "ft-js" },
  mjs: { icon: "javascript", tone: "ft-js" },
  cjs: { icon: "javascript", tone: "ft-js" },
  json: { icon: "braces", tone: "ft-json" },
  jsonc: { icon: "braces", tone: "ft-json" },
  yaml: { icon: "settings", tone: "ft-json" },
  yml: { icon: "settings", tone: "ft-json" },
  toml: { icon: "settings", tone: "ft-json" },
  css: { icon: "hash", tone: "ft-css" },
  scss: { icon: "hash", tone: "ft-css" },
  less: { icon: "hash", tone: "ft-css" },
  html: { icon: "markup", tone: "ft-html" },
  htm: { icon: "markup", tone: "ft-html" },
  xml: { icon: "markup", tone: "ft-html" },
  md: { icon: "markdown", tone: "ft-md" },
  mdx: { icon: "markdown", tone: "ft-md" },
  sh: { icon: "shell", tone: "ft-test" },
  bash: { icon: "shell", tone: "ft-test" },
  zsh: { icon: "shell", tone: "ft-test" },
  lock: { icon: "lock", tone: "ft-lock" },
  lockb: { icon: "lock", tone: "ft-lock" },
  png: { icon: "image", tone: "ft-image" },
  jpg: { icon: "image", tone: "ft-image" },
  jpeg: { icon: "image", tone: "ft-image" },
  gif: { icon: "image", tone: "ft-image" },
  webp: { icon: "image", tone: "ft-image" },
  svg: { icon: "image", tone: "ft-image" },
  ico: { icon: "image", tone: "ft-image" },
};

const LOCK_FILES = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"]);
const CONFIG_FILES = new Set(["dockerfile", "caddyfile", "procfile"]);

const TEST_SUFFIX_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const CONFIG_SUFFIX_RE = /\.config\.[cm]?[jt]s$/i;

export function fileKindOf(name: string): FileKind {
  const lower = name.toLowerCase();
  if (LOCK_FILES.has(lower)) return { icon: "lock", tone: "ft-lock" };
  if (lower === "license" || lower.startsWith("license.")) return { icon: "markdown", tone: "ft-md" };
  if (CONFIG_FILES.has(lower)) return { icon: "settings", tone: "" };
  if (TEST_SUFFIX_RE.test(lower)) return { icon: "test", tone: "ft-test" };
  if (CONFIG_SUFFIX_RE.test(lower)) return { icon: "settings", tone: "ft-json" };

  const dot = lower.lastIndexOf(".");
  // A leading dot alone (".gitignore", ".env") makes a dotfile; ".eslintrc.json" is JSON.
  const extension = dot > 0 ? lower.slice(dot + 1) : "";
  const known = BY_EXTENSION[extension];
  if (known) return known;
  if (lower.startsWith(".")) return { icon: "settings", tone: "" };
  return { icon: "file", tone: "" };
}
