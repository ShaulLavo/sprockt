// Light or dark, following the system until the user picks the other one. The choice is stored
// host-only in localStorage and applied as `data-theme` on <html>; the tokens in styles.css do
// the rest with `light-dark()`.
import { createSignal, type Accessor } from "solid-js";

export type ThemePreference = "system" | "light" | "dark";
export type ColorScheme = "light" | "dark";

export const THEME_STORAGE_KEY = "sprockt:theme";

/** The browser chrome color behind the status bar on phones: the title bar's background. */
const CHROME_COLOR: Readonly<Record<ColorScheme, string>> = { light: "#eef1f5", dark: "#0d1117" };

export function parsePreference(value: string | null | undefined): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

export function resolveScheme(preference: ThemePreference, systemScheme: ColorScheme): ColorScheme {
  return preference === "system" ? systemScheme : preference;
}

/** Picking the theme the system already uses goes back to following the system. */
export function preferenceFor(scheme: ColorScheme, systemScheme: ColorScheme): ThemePreference {
  return scheme === systemScheme ? "system" : scheme;
}

function readStored(): ThemePreference {
  try {
    return parsePreference(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

function store(preference: ThemePreference): void {
  try {
    if (preference === "system") localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Storage can be blocked (private windows, site settings); the choice then lasts this visit.
  }
}

const systemQuery = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : undefined;
const systemNow = (): ColorScheme => (systemQuery?.matches === false ? "light" : "dark");
const [preference, setPreference] = createSignal<ThemePreference>(readStored());
const [system, setSystem] = createSignal<ColorScheme>(systemNow());

export const themePreference: Accessor<ThemePreference> = preference;
/** The scheme in effect right now, for things CSS cannot reach (the terminal's canvas). */
export const colorScheme: Accessor<ColorScheme> = () => resolveScheme(preference(), system());

/** Writes the document first, so effects that read resolved CSS colors see the new theme. */
function applyToDocument(next: ThemePreference, systemScheme: ColorScheme): void {
  const root = document.documentElement;
  if (next === "system") delete root.dataset.theme;
  else root.dataset.theme = next;
  // index.html has one theme-color per system scheme; an explicit choice sets both to its color.
  const metas = Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'));
  if (metas.length === 0) {
    const meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.append(meta);
    metas.push(meta);
  }
  for (const meta of metas) {
    const own: ColorScheme = meta.media.includes("light")
      ? "light"
      : meta.media.includes("dark")
        ? "dark"
        : systemScheme;
    meta.content = CHROME_COLOR[next === "system" ? own : next];
  }
}

/** The two-state toggle: show the page in `scheme`. */
export function setColorScheme(scheme: ColorScheme): void {
  const next = preferenceFor(scheme, system());
  store(next);
  applyToDocument(next, system());
  setPreference(next);
}

let started = false;

/** Applies the stored choice and follows system changes. Call once at startup. */
export function applyStoredTheme(): void {
  applyToDocument(preference(), system());
  if (started) return;
  started = true;
  systemQuery?.addEventListener("change", () => {
    applyToDocument(preference(), systemNow());
    setSystem(systemNow());
  });
}
