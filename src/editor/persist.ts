// Open tabs and the active tab, remembered per workspace in this browser. A convenience: when the
// storage is missing, full or blocked the editor simply starts with no tabs.
import type { EditorTab } from "./tabs";

export interface SavedTabs {
  readonly tabs: readonly EditorTab[];
  readonly active: string | undefined;
}

const EMPTY: SavedTabs = { tabs: [], active: undefined };

const storageKey = (workspaceId: string) => `sprockt:${workspaceId}:editor-tabs`;

function isTab(value: unknown): value is EditorTab {
  if (typeof value !== "object" || value === null) return false;
  const tab = value as Record<string, unknown>;
  return typeof tab.path === "string" && tab.path !== "" && typeof tab.preview === "boolean";
}

/** Reads what `serializeTabs` wrote. Anything malformed or duplicated is dropped, never trusted. */
export function parseSavedTabs(raw: string | null): SavedTabs {
  if (!raw) return EMPTY;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return EMPTY;
  }
  if (typeof value !== "object" || value === null) return EMPTY;
  const record = value as Record<string, unknown>;
  const seen = new Set<string>();
  const tabs = (Array.isArray(record.tabs) ? record.tabs : []).filter(isTab).filter((tab) => {
    if (seen.has(tab.path)) return false;
    seen.add(tab.path);
    return true;
  });
  const active = typeof record.active === "string" && seen.has(record.active) ? record.active : tabs[0]?.path;
  return { tabs: tabs.map((tab) => ({ path: tab.path, preview: tab.preview })), active };
}

export function serializeTabs(saved: SavedTabs): string {
  return JSON.stringify({ tabs: saved.tabs, active: saved.active });
}

export function loadTabs(workspaceId: string): SavedTabs {
  try {
    return parseSavedTabs(localStorage.getItem(storageKey(workspaceId)));
  } catch {
    return EMPTY;
  }
}

export function saveTabs(workspaceId: string, saved: SavedTabs): void {
  try {
    localStorage.setItem(storageKey(workspaceId), serializeTabs(saved));
  } catch {
    // Storage is a convenience here; a full or blocked store only forgets the tabs.
  }
}
