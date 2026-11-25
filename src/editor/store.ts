import { createSignal, type Accessor } from "solid-js";

/** Which project files are open in the editor. Paths are project-relative. */
export interface EditorStore {
  readonly active: Accessor<string | undefined>;
  readonly dirty: Accessor<boolean>;
  open(path: string): void;
  setDirty(dirty: boolean): void;
}

export function createEditorStore(): EditorStore {
  const [active, setActive] = createSignal<string>();
  const [dirty, setDirty] = createSignal(false);
  return {
    active,
    dirty,
    setDirty,
    open(path) {
      setDirty(false);
      setActive(path);
    },
  };
}
