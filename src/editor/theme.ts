// The editor's colours come from the IDE's design tokens (Circuit `--syn-*`, `--bg-editor`, …), so
// one stylesheet themes the whole workbench. Each value is a CSS `var()` the editor element
// resolves; the fallbacks are Circuit's own values for when the tokens are not loaded.
import type { EditorTheme } from "@singapore-editor/core/rendering";
import { createSignal, onCleanup, type Accessor } from "solid-js";

export type ColorScheme = "light" | "dark";

const token = (name: string, light: string, dark: string) => `var(--${name}, light-dark(${light}, ${dark}))`;

const SYNTAX = {
  text: token("syn-text", "#0f1520", "#dde4ee"),
  keyword: token("syn-keyword", "#1f5fc4", "#82b8ff"),
  string: token("syn-string", "#2f7a2f", "#a6dd8b"),
  function: token("syn-function", "#8a5a00", "#ffd479"),
  type: token("syn-type", "#0a7a6a", "#7fdcc8"),
  attribute: token("syn-attr", "#b4541a", "#ffb27a"),
  number: token("syn-number", "#c2410c", "#ff9e7a"),
  property: token("syn-property", "#2f4a72", "#bcd0ec"),
  punctuation: token("syn-punct", "#5b6678", "#8b97a8"),
  comment: token("syn-comment", "#717c8d", "#687587"),
};

/** The editor theme for a scheme. Colours are the same `var()`s; the type picks plugin defaults. */
export function editorTheme(scheme: ColorScheme): EditorTheme {
  return {
    type: scheme,
    backgroundColor: token("bg-editor", "#ffffff", "#151c26"),
    foregroundColor: SYNTAX.text,
    gutterBackgroundColor: token("bg-editor", "#ffffff", "#151c26"),
    gutterForegroundColor: token("fg-subtle", "#5f6a7b", "#7f8b9c"),
    selectionColor: token("bg-selection", "#fbcadb", "#4a2338"),
    inactiveSelectionColor: token("bg-hover", "#e6ebf2", "#1b2431"),
    popupBackgroundColor: token("bg-elevated", "#ffffff", "#1c2533"),
    caretColor: token("caret", "#d1245a", "#ff7ea2"),
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
