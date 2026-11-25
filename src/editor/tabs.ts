// The open-tab list as plain data. Every operation returns a new list and leaves its input alone,
// so the store can keep the list in one signal and these rules stay testable without a DOM.

export interface EditorTab {
  /** Project-relative path, the tab's identity. */
  readonly path: string;
  /** A preview tab is replaced by the next preview instead of piling up; editing pins it. */
  readonly preview: boolean;
}

/** Opens `path`, after the active tab when it is new. A preview replaces the current preview. */
export function openTab(
  tabs: readonly EditorTab[],
  path: string,
  options: { readonly preview: boolean; readonly after?: string },
): EditorTab[] {
  const existing = tabs.findIndex((tab) => tab.path === path);
  if (existing >= 0) return options.preview ? tabs.slice() : pinTab(tabs, path);
  const tab: EditorTab = { path, preview: options.preview };
  const previewIndex = options.preview ? tabs.findIndex((candidate) => candidate.preview) : -1;
  if (previewIndex >= 0) return tabs.slice(0, previewIndex).concat([tab], tabs.slice(previewIndex + 1));
  const anchor =
    options.after === undefined ? -1 : tabs.findIndex((candidate) => candidate.path === options.after);
  const at = anchor >= 0 ? anchor + 1 : tabs.length;
  return tabs.slice(0, at).concat([tab], tabs.slice(at));
}

export function pinTab(tabs: readonly EditorTab[], path: string): EditorTab[] {
  return tabs.map((tab) => (tab.path === path && tab.preview ? { path, preview: false } : tab));
}

/** Closes `path` and says which tab becomes active: its right neighbour, else its left one. */
export function closeTab(
  tabs: readonly EditorTab[],
  path: string,
  active: string | undefined,
): { tabs: EditorTab[]; active: string | undefined } {
  const index = tabs.findIndex((tab) => tab.path === path);
  if (index < 0) return { tabs: tabs.slice(), active };
  const remaining = tabs.slice(0, index).concat(tabs.slice(index + 1));
  if (active !== path) return { tabs: remaining, active };
  const next = remaining[Math.min(index, remaining.length - 1)];
  return { tabs: remaining, active: next?.path };
}

/** Moves the tab at `from` so that it ends up at index `to`. Out-of-range indexes are clamped. */
export function moveTab(tabs: readonly EditorTab[], from: number, to: number): EditorTab[] {
  const moved = tabs[from];
  if (!moved) return tabs.slice();
  const rest = tabs.slice(0, from).concat(tabs.slice(from + 1));
  const at = Math.max(0, Math.min(to, rest.length));
  return rest.slice(0, at).concat([moved], rest.slice(at));
}

/** The path after a file or one of its parent directories moved, or the same path. */
export function renamedPath(path: string, from: string, to: string): string {
  if (path === from) return to;
  return path.startsWith(`${from}/`) ? to + path.slice(from.length) : path;
}

/** Follows a move of a file or directory. Tabs that would collide with an open tab are dropped. */
export function renameTabs(tabs: readonly EditorTab[], from: string, to: string): EditorTab[] {
  const seen = new Set<string>();
  return tabs.flatMap((tab) => {
    const path = renamedPath(tab.path, from, to);
    if (seen.has(path)) return [];
    seen.add(path);
    return [path === tab.path ? tab : { path, preview: tab.preview }];
  });
}
