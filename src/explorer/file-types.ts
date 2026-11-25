// Which icon and colour a file gets. A different glyph per kind, not one glyph in different
// colours, so the tree reads at a glance and for people who cannot tell the colours apart.
export type FileIcon =
  | "file"
  | "typescript"
  | "javascript"
  | "react"
  | "braces"
  | "hash"
  | "markup"
  | "markdown"
  | "lock"
  | "settings"
  | "image";

/** The tone class (`ft-*`) that colours the icon, from Circuit's file-type tokens. */
export type FileTone =
  | "ft-ts"
  | "ft-js"
  | "ft-json"
  | "ft-css"
  | "ft-html"
  | "ft-md"
  | "ft-lock"
  | "ft-image"
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
  css: { icon: "hash", tone: "ft-css" },
  scss: { icon: "hash", tone: "ft-css" },
  less: { icon: "hash", tone: "ft-css" },
  html: { icon: "markup", tone: "ft-html" },
  htm: { icon: "markup", tone: "ft-html" },
  md: { icon: "markdown", tone: "ft-md" },
  mdx: { icon: "markdown", tone: "ft-md" },
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

export function fileKindOf(name: string): FileKind {
  if (LOCK_FILES.has(name)) return { icon: "lock", tone: "ft-lock" };
  const dot = name.lastIndexOf(".");
  // A leading dot alone (".gitignore", ".env") makes a dotfile; ".eslintrc.json" is JSON.
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  const known = BY_EXTENSION[extension];
  if (known) return known;
  if (name.startsWith(".")) return { icon: "settings", tone: "" };
  return { icon: "file", tone: "" };
}
