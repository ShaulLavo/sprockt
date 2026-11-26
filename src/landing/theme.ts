// Two-state light/dark theme controller. Defaults to system preference until toggled.
import { createSignal, onCleanup, type Accessor } from "solid-js";

export type Theme = "light" | "dark";

const THEME_STORAGE_KEY = "sprockt:theme";

function readStoredTheme(): Theme | undefined {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return value === "light" || value === "dark" ? value : undefined;
  } catch {
    return undefined;
  }
}

function systemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

const CHROME_COLOR: Readonly<Record<Theme, string>> = { light: "#ffffff", dark: "#0a0d14" };

function applyThemeAttribute(theme: Theme | undefined): void {
  if (theme) {
    document.documentElement.dataset.theme = theme;
  } else {
    delete document.documentElement.dataset.theme;
  }
  const metas = Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'));
  for (const meta of metas) {
    if (theme) {
      meta.content = CHROME_COLOR[theme];
    } else if (meta.media.includes("light")) {
      meta.content = CHROME_COLOR.light;
    } else if (meta.media.includes("dark")) {
      meta.content = CHROME_COLOR.dark;
    }
  }
}

export function createThemeController(): {
  readonly resolved: Accessor<Theme>;
  readonly setTheme: (next: Theme) => void;
} {
  const initialStored = readStoredTheme();
  applyThemeAttribute(initialStored);
  const [explicit, setExplicit] = createSignal<Theme | undefined>(initialStored);
  const [system, setSystem] = createSignal<Theme>(systemTheme());

  const media = window.matchMedia("(prefers-color-scheme: light)");
  const onSystemChange = () => setSystem(media.matches ? "light" : "dark");
  media.addEventListener("change", onSystemChange);
  onCleanup(() => media.removeEventListener("change", onSystemChange));

  function setTheme(next: Theme): void {
    setExplicit(next);
    applyThemeAttribute(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Ignore private-mode storage refusals.
    }
  }

  return {
    resolved: () => explicit() ?? system(),
    setTheme,
  };
}
