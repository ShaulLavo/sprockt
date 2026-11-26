// The preview pane's own back and forward list. The frame's browser history is shared with
// the IDE page it sits in, so calling `history.back()` inside the frame could walk the IDE
// itself back. The pane keeps the list of places the frame reported and navigates to them.

export interface PreviewHistory {
  /** Paths (with query and hash) on the dev server, oldest first. */
  readonly entries: readonly string[];
  /** The entry the frame is at, or -1 before the first page loaded. */
  readonly index: number;
}

export const emptyHistory: PreviewHistory = { entries: [], index: -1 };

export const currentPath = (history: PreviewHistory): string | undefined => history.entries[history.index];
export const canGoBack = (history: PreviewHistory): boolean => history.index > 0;
export const canGoForward = (history: PreviewHistory): boolean => history.index < history.entries.length - 1;

/**
 * The frame reported that it is at `path`. Arriving where the list already points (a reload,
 * or the end of a back or forward step) changes nothing; anything else is a new entry that
 * replaces whatever lay ahead.
 */
export function visited(history: PreviewHistory, path: string): PreviewHistory {
  if (currentPath(history) === path) return history;
  const entries = history.entries.slice(0, history.index + 1).concat([path]);
  return { entries, index: entries.length - 1 };
}

/** Moves one entry back (-1) or forward (+1), staying inside the list. */
export function stepped(history: PreviewHistory, delta: -1 | 1): PreviewHistory {
  const index = history.index + delta;
  return index < 0 || index >= history.entries.length ? history : { entries: history.entries, index };
}
