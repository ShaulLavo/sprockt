// The pane layout of one workspace, persisted host-only in localStorage. Drags update it every
// frame without writing storage; `commit` saves once the drag ends.
import { createSignal, type Accessor } from "../lib/reactive";
import { GLOBAL_LAYOUT_KEY, layoutStorageKey, parseLayout, serializeLayout, type PaneLayout } from "./layout";

export interface LayoutStore {
  readonly layout: Accessor<PaneLayout>;
  /** Shows a layout without saving it, for each frame of a drag. */
  show(next: PaneLayout): void;
  /** Shows and saves a layout. */
  set(next: PaneLayout): void;
  /** Saves whatever is shown. */
  commit(): void;
}

function load(workspaceId: string): PaneLayout {
  try {
    const globalSaved = localStorage.getItem(GLOBAL_LAYOUT_KEY);
    if (globalSaved !== null) return parseLayout(globalSaved);
    return parseLayout(localStorage.getItem(layoutStorageKey(workspaceId)));
  } catch {
    return parseLayout(null);
  }
}

function save(layout: PaneLayout): void {
  try {
    localStorage.setItem(GLOBAL_LAYOUT_KEY, serializeLayout(layout));
  } catch {
    // Storage blocked or full: the layout still works, it just is not remembered.
  }
}

export function createLayoutStore(workspaceId: string): LayoutStore {
  const [layout, setLayout] = createSignal<PaneLayout>(load(workspaceId));
  return {
    layout,
    show: setLayout,
    set(next) {
      setLayout(next);
      save(next);
    },
    commit: () => save(layout()),
  };
}
