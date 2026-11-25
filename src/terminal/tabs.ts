// Terminal tabs as plain data. A tab is one shell. The panel shows the active tab, and when it is
// split, a second tab to its right; `focused` is whichever of the two takes keyboard input.
// Pure functions over immutable state, so the rules are unit tested without a browser.

export interface TerminalTab {
  readonly id: string;
  readonly title: string;
  /** Set once the user renames the tab; the shell's own title no longer replaces it. */
  readonly named: boolean;
}

export interface TerminalTabs {
  readonly tabs: readonly TerminalTab[];
  /** The tab on the left, or the only one shown. */
  readonly active: string | undefined;
  /** The tab shown to the right of the active one, when the panel is split. */
  readonly split: string | undefined;
  readonly focused: string | undefined;
}

export const NO_TABS: TerminalTabs = { tabs: [], active: undefined, split: undefined, focused: undefined };

const SHELL_NAME = "bash";

/** "bash", then "bash 2", "bash 3": the lowest number no open tab uses. */
export function nextTitle(state: TerminalTabs): string {
  const used = new Set(state.tabs.map((tab) => tab.title));
  if (!used.has(SHELL_NAME)) return SHELL_NAME;
  let number = 2;
  while (used.has(`${SHELL_NAME} ${number}`)) number += 1;
  return `${SHELL_NAME} ${number}`;
}

/** Adds a tab and focuses it, either as the shown tab or as the right half of a split. */
export function addTab(
  state: TerminalTabs,
  id: string,
  title: string = nextTitle(state),
  placement: "tab" | "split" = "tab",
): TerminalTabs {
  const tabs = state.tabs.concat({ id, title, named: false });
  if (placement === "split" && state.active) return { tabs, active: state.active, split: id, focused: id };
  return { tabs, active: id, split: undefined, focused: id };
}

/** Shows a tab. A tab already on screen only takes focus; any other one ends the split. */
export function selectTab(state: TerminalTabs, id: string): TerminalTabs {
  if (!state.tabs.some((tab) => tab.id === id)) return state;
  if (id === state.active || id === state.split) return { ...state, focused: id };
  return { ...state, active: id, split: undefined, focused: id };
}

/** Removes a tab. Its neighbour takes its place, preferring the other half of a split. */
export function closeTab(state: TerminalTabs, id: string): TerminalTabs {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return state;
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  if (id === state.split) return { tabs, active: state.active, split: undefined, focused: state.active };
  if (id === state.active && state.split) {
    return { tabs, active: state.split, split: undefined, focused: state.split };
  }
  if (id !== state.active) {
    const focused = state.focused === id ? state.active : state.focused;
    return { ...state, tabs, focused };
  }
  const neighbour = tabs[Math.min(index, tabs.length - 1)]?.id;
  return { tabs, active: neighbour, split: undefined, focused: neighbour };
}

/** Ends a split, keeping the focused half on screen; both shells keep running as tabs. */
export function unsplit(state: TerminalTabs): TerminalTabs {
  if (!state.split) return state;
  const shown = state.focused ?? state.active;
  return { ...state, active: shown, split: undefined, focused: shown };
}

/** A user rename. A blank name gives the tab back to the shell's own title. */
export function renameTab(state: TerminalTabs, id: string, title: string): TerminalTabs {
  const trimmed = title.trim();
  return {
    ...state,
    tabs: state.tabs.map((tab) => {
      if (tab.id !== id) return tab;
      return trimmed ? { ...tab, title: trimmed, named: true } : { ...tab, named: false };
    }),
  };
}

/** The title a shell set (OSC 0 or 2). A tab the user named keeps its name. */
export function shellTitle(state: TerminalTabs, id: string, title: string): TerminalTabs {
  const trimmed = title.trim();
  if (!trimmed) return state;
  return {
    ...state,
    tabs: state.tabs.map((tab) => (tab.id === id && !tab.named ? { ...tab, title: trimmed } : tab)),
  };
}

/** The tab after (or before) the focused one, wrapping around. */
export function cycleTab(state: TerminalTabs, direction: 1 | -1): TerminalTabs {
  const count = state.tabs.length;
  if (count < 2) return state;
  const index = state.tabs.findIndex((tab) => tab.id === state.focused);
  const next = state.tabs[(index + direction + count) % count];
  return next ? selectTab(state, next.id) : state;
}
