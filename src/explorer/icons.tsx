// Circuit's stroke icons (the mock's icon paths), inlined so the explorer needs no sprite or font.
// Stroke width and colour come from CSS (`.ico`).
import type { FileIcon } from "./file-types";

const FILE = "M13.5 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5z";
const FOLDER =
  "M3.5 7A1.5 1.5 0 0 1 5 5.5h4l2 2.5h8A1.5 1.5 0 0 1 20.5 9.5V17a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 17z";
const TRAY = "M4.5 15v3.5a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1V15";

interface Glyph {
  readonly paths: readonly string[];
  /** Two letters drawn inside, for the languages whose letters are their logo. */
  readonly label?: string;
}

const GLYPHS = {
  chevronRight: { paths: ["m9.5 6 6 6-6 6"] },
  chevronDown: { paths: ["m6 9.5 6 6 6-6"] },
  folder: { paths: [FOLDER] },
  folderOpen: {
    paths: [
      "M3.5 17.5V7A1.5 1.5 0 0 1 5 5.5h4l2 2.5h6.5A1.5 1.5 0 0 1 19 9.5V11",
      "M3.5 17.5 6 12h14.5l-2.2 5.5a1.5 1.5 0 0 1-1.4 1H5a1.5 1.5 0 0 1-1.5-1z",
    ],
  },
  filePlus: { paths: [FILE, "M13.5 3.5v5h5M12 11.5v6M9 14.5h6"] },
  folderPlus: { paths: [FOLDER, "M12 10.5v5M9.5 13h5"] },
  collapse: { paths: ["m7 10 5-5 5 5M7 19l5-5 5 5"] },
  upload: { paths: ["M12 15V4.5M7.5 9 12 4.5 16.5 9", TRAY] },
  download: { paths: ["M12 4.5V15M7.5 10.5 12 15l4.5-4.5", TRAY] },
  more: { paths: ["M5.5 12h.01M12 12h.01M18.5 12h.01"] },
  // File kinds.
  file: { paths: [FILE, "M13.5 3.5v5h5"] },
  typescript: {
    paths: [
      "M4.5 6A1.5 1.5 0 0 1 6 4.5h12A1.5 1.5 0 0 1 19.5 6v12a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18z",
    ],
    label: "TS",
  },
  javascript: {
    paths: [
      "M4.5 6A1.5 1.5 0 0 1 6 4.5h12A1.5 1.5 0 0 1 19.5 6v12a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18z",
    ],
    label: "JS",
  },
  react: {
    paths: [
      "M12 12.01h.01",
      "M12 6.5c4.7 0 8.5 2.5 8.5 5.5s-3.8 5.5-8.5 5.5-8.5-2.5-8.5-5.5S7.3 6.5 12 6.5z",
      "M8.8 9.25c2.35-4.1 5.3-6.2 6.9-5.3s1.5 4.4-.85 8.5-5.3 6.2-6.9 5.3-1.5-4.4.85-8.5z",
      "M8.8 14.75c-2.35-4.1-2.45-7.6-.85-8.5s4.55 1.2 6.9 5.3 2.45 7.6.85 8.5-4.55-1.2-6.9-5.3z",
    ],
  },
  braces: {
    paths: [
      "M9 4.5H8A2 2 0 0 0 6 6.5v3A2 2 0 0 1 4 11.5 2 2 0 0 1 6 13.5v3a2 2 0 0 0 2 2h1",
      "M15 4.5h1a2 2 0 0 1 2 2v3a2 2 0 0 0 2 2 2 2 0 0 0-2 2v3a2 2 0 0 1-2 2h-1",
    ],
  },
  hash: { paths: ["M9.5 4.5 8 19.5M16 4.5l-1.5 15M5 9h14.5M4.5 15H19"] },
  markup: { paths: ["m8.5 7.5-5 4.5 5 4.5M15.5 7.5l5 4.5-5 4.5M13.5 5l-3 14"] },
  markdown: {
    paths: [
      "M4 6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5v11a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z",
      "M7 15V9l2.5 3L12 9v6M16 9v6m-2-2.2 2 2.2 2-2.2",
    ],
  },
  lock: {
    paths: [
      "M6.5 11h11a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V12a1 1 0 0 1 1-1z",
      "M8.5 11V8a3.5 3.5 0 0 1 7 0v3",
      "M12 14.5v2",
    ],
  },
  settings: {
    paths: [
      "M4 7h9M17 7h3M4 17h3M11 17h9",
      "M15 7m-2 0a2 2 0 1 0 4 0 2 2 0 1 0-4 0M9 17m-2 0a2 2 0 1 0 4 0 2 2 0 1 0-4 0",
    ],
  },
  image: {
    paths: [
      "M5.5 4.5h13A1.5 1.5 0 0 1 20 6v12a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18V6a1.5 1.5 0 0 1 1.5-1.5z",
      "M8.5 9.5h.01",
      "m4.5 17 4.5-4.5 3 3 3-3.5 4.5 5",
    ],
  },
} as const satisfies Record<string, Glyph>;

export type IconName = keyof typeof GLYPHS;

export function Icon(props: { name: IconName; class?: string }) {
  const glyph: Glyph = GLYPHS[props.name];
  return (
    <svg className={`ico ${props.class ?? ""}`} viewBox="0 0 24 24" aria-hidden="true">
      {glyph.paths.map((d) => (
        <path key={d} d={d} />
      ))}
      {glyph.label ? (
        <text
          x="12"
          y="15.6"
          textAnchor="middle"
          fontSize="8.6"
          fontWeight="700"
          fill="currentColor"
          stroke="none"
        >
          {glyph.label}
        </text>
      ) : null}
    </svg>
  );
}

export const FILE_ICONS: Readonly<Record<FileIcon, IconName>> = {
  file: "file",
  typescript: "typescript",
  javascript: "javascript",
  react: "react",
  braces: "braces",
  hash: "hash",
  markup: "markup",
  markdown: "markdown",
  lock: "lock",
  settings: "settings",
  image: "image",
};
