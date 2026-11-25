import { createSignal, type Accessor } from "solid-js";
import { Documents, type Conflict, type Draft } from "./documents";

/** Which project files the editor has open. Paths are project-relative. */
export interface EditorStore {
  /** The file selected in the explorer. */
  readonly active: Accessor<string | undefined>;
  /** The file on screen. It trails `active` while the selected file is being read. */
  readonly displayed: Accessor<string | undefined>;
  /** Whether the file on screen has unsaved edits. */
  readonly dirty: Accessor<boolean>;
  /** Set when a save found the file changed on disk; cleared when the person chose a version. */
  readonly conflict: Accessor<Conflict | undefined>;
  /** Whether `path` has unsaved text, on screen or kept from before a switch. */
  hasUnsaved(path: string): boolean;
  open(path: string): void;
  /** The model behind the accessors. The editor pane drives it and calls `changed()` after. */
  readonly documents: Documents;
  changed(): void;
}

export function createEditorStore(recover?: (path: string) => Draft | undefined): EditorStore {
  const documents = new Documents(recover);
  const [version, setVersion] = createSignal(0);
  const changed = () => void setVersion((value) => value + 1);
  /** Reads the model reactively: every accessor re-runs after `changed()`. */
  const tracked =
    <T>(read: () => T): Accessor<T> =>
    () => (version(), read());

  return {
    documents,
    changed,
    active: tracked(() => documents.selected),
    displayed: tracked(() => documents.displayed),
    dirty: tracked(() => documents.dirty),
    conflict: tracked(() => documents.conflict),
    hasUnsaved: (path) => (version(), documents.hasUnsaved(path)),
    open(path) {
      if (documents.select(path)) changed();
    },
  };
}
