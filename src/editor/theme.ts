// The editor's colours come from the IDE's design tokens (Sheet & Biro / dark sibling `--syn-*`,
// `--bg-editor`, …), so one stylesheet themes the whole workbench.
import type { EditorTheme } from "@singapore-editor/core/rendering";
import { createSignal, onCleanup, type Accessor } from "solid-js";

export type ColorScheme = "light" | "dark";

const token = (name: string, light: string, dark: string) => `var(--${name}, light-dark(${light}, ${dark}))`;

const SYNTAX = {
  text: token("syn-text", "#181b20", "#d8dfe9"),
  keyword: token("syn-keyword", "#1a4be0", "#6cc2ff"),
  string: token("syn-string", "#0b7a4b", "#9de09a"),
  function: token("syn-function", "#8a3c00", "#f2c779"),
  type: token("syn-type", "#0f6680", "#68d8d6"),
  attribute: token("syn-attr", "#8a3c00", "#ffab78"),
  number: token("syn-number", "#a3123f", "#f48fb1"),
  property: token("syn-property", "#24344d", "#c6d4e8"),
  punctuation: token("syn-punct", "#5c616b", "#8893a6"),
  comment: token("syn-comment", "#616772", "#7d899d"),
};

/** The editor theme for a scheme. Colours are the same `var()`s; the type picks plugin defaults. */
export function editorTheme(scheme: ColorScheme): EditorTheme {
  return {
    type: scheme,
    backgroundColor: token("bg-editor", "#ffffff", "#0a0d14"),
    foregroundColor: SYNTAX.text,
    gutterBackgroundColor: token("bg-editor", "#ffffff", "#0a0d14"),
    gutterForegroundColor: token("fg-subtle", "#5c616b", "#8893a6"),
    selectionColor: token("bg-selection", "#cfe0ff", "#1f3b5c"),
    inactiveSelectionColor: token("bg-hover", "#f1f3f7", "#1c2333"),
    popupBackgroundColor: token("bg-elevated", "#ffffff", "#161b26"),
    caretColor: token("caret", "#1a4be0", "#5ab9fc"),
    // A problem is underlined in its status color. The code under it keeps its place in the page:
    // no red wash across whole lines, so a file with many problems is still readable.
    colors: {
      "lsp.diagnostic.error": SYNTAX.text,
      "lsp.diagnostic.errorBackground": "transparent",
      "lsp.diagnostic.errorUnderline": token("danger", "#c81e2b", "#f87171"),
      "lsp.diagnostic.warningBackground": `color-mix(in oklab, ${token("warn", "#9a5b00", "#f2c779")} 20%, transparent)`,
      "lsp.diagnostic.informationBackground": `color-mix(in oklab, ${token("info", "#1a4be0", "#5ab9fc")} 16%, transparent)`,
    },
    syntax: {
      keyword: SYNTAX.keyword,
      keywordDeclaration: SYNTAX.keyword,
      keywordImport: SYNTAX.keyword,
      string: SYNTAX.string,
      comment: SYNTAX.comment,
      function: SYNTAX.function,
      type: SYNTAX.type,
      typeDefinition: SYNTAX.type,
      typeParameter: SYNTAX.type,
      namespace: SYNTAX.type,
      number: SYNTAX.number,
      constant: SYNTAX.number,
      property: SYNTAX.property,
      attribute: SYNTAX.attribute,
      variable: SYNTAX.text,
      variableBuiltin: SYNTAX.keyword,
      parameter: SYNTAX.text,
      bracket: SYNTAX.punctuation,
    },
  };
}

/** The page's scheme: an explicit `color-scheme` on the root wins, else the system preference. */
function currentScheme(media: MediaQueryList): ColorScheme {
  const declared = getComputedStyle(document.documentElement).colorScheme.split(/\s+/);
  const only = declared.filter((value) => value === "light" || value === "dark");
  if (only.length === 1) return only[0] as ColorScheme;
  return media.matches ? "dark" : "light";
}

/**
 * Follows the IDE's light or dark mode: the system setting and any `data-theme`, `class` or
 * `style` change on the root element. Call inside a component.
 */
export function createColorScheme(): Accessor<ColorScheme> {
  const media = matchMedia("(prefers-color-scheme: dark)");
  const [scheme, setScheme] = createSignal(currentScheme(media));
  const update = () => setScheme(currentScheme(media));
  media.addEventListener("change", update);
  const observer = new MutationObserver(update);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "class", "style"],
  });
  onCleanup(() => {
    media.removeEventListener("change", update);
    observer.disconnect();
  });
  return scheme;
}
