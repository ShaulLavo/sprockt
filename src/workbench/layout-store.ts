// The pane layout of one workspace, persisted host-only in localStorage. Drags update it every
// frame without writing storage; `commit` saves once the drag ends.
import { createSignal, type Accessor } from "solid-js";
import { layoutStorageKey, parseLayout, serializeLayout, type PaneLayout } from "./layout";

export interface LayoutStore {
  readonly layout: Accessor<PaneLayout>;
  /** Shows a layout without saving it, for each frame of a drag. */
  show(next: PaneLayout): void;
  /** Shows and saves a layout. */
  set(next: PaneLayout): void;
  /** Saves whatever is shown. */
  commit(): void;
}

function load(key: string): PaneLayout {
  try {
    return parseLayout(localStorage.getItem(key));
  } catch {
    return parseLayout(null);
  }
}

function save(key: string, layout: PaneLayout): void {
  try {
    localStorage.setItem(key, serializeLayout(layout));
  } catch {
    // Storage blocked or full: the layout still works, it just is not remembered.
  }
}

export function createLayoutStore(workspaceId: string): LayoutStore {
  const key = layoutStorageKey(workspaceId);
  const [layout, setLayout] = createSignal<PaneLayout>(load(key));
  return {
    layout,
    show: setLayout,
    set(next) {
      setLayout(next);
      save(key, next);
    },
    commit: () => save(key, layout()),
  };
}
