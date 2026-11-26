import { useEffect, useRef } from "react";
import { originalPath } from "./buffers";
import { EDITOR_COPY, fill } from "./copy";

const basename = (path: string) => {
  const real = originalPath(path);
  return real.slice(real.lastIndexOf("/") + 1);
};

/**
 * Sheet & Biro confirmation dialog when closing one or more tabs with unsaved edits.
 * Offers Save, Don't Save, and Cancel, and restores focus to where the person was on cancel.
 */
export function UnsavedChangesDialog(props: {
  readonly paths: readonly string[];
  readonly saving?: boolean;
  readonly error?: string;
  onSave(): void;
  onDiscard(): void;
  onCancel(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const count = props.paths.length;
  const first = props.paths[0] ?? "";
  const title =
    count > 1
      ? fill(EDITOR_COPY.unsavedManyTitle, { count })
      : fill(EDITOR_COPY.unsavedTitle, { name: basename(first) });
  const body = count > 1 ? EDITOR_COPY.unsavedManyBody : EDITOR_COPY.unsavedBody;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
    saveButton.current?.focus();
    return () => {
      if (previous && previous.isConnected) previous.focus();
    };
  }, []);

  return (
    <dialog
      ref={dialog}
      className="tree-dialog unsaved-dialog"
      data-testid="unsaved-dialog"
      aria-labelledby="unsaved-dialog-title"
      aria-describedby="unsaved-dialog-body"
      onCancel={(event) => {
        event.preventDefault();
        if (!props.saving) props.onCancel();
      }}
      onClose={() => {
        if (!props.saving) props.onCancel();
      }}
    >
      <h2 id="unsaved-dialog-title">{title}</h2>
      <p id="unsaved-dialog-body">{body}</p>
      {props.error ? (
        <p className="unsaved-dialog-error" role="alert" data-testid="unsaved-error">
          {props.error}
        </p>
      ) : null}
      <div className="tree-dialog-actions">
        <button
          type="button"
          className="tree-dialog-button"
          data-testid="unsaved-cancel"
          disabled={props.saving}
          onClick={() => props.onCancel()}
        >
          {EDITOR_COPY.cancel}
        </button>
        <button
          type="button"
          className="tree-dialog-button danger"
          data-testid="unsaved-discard"
          disabled={props.saving}
          onClick={() => props.onDiscard()}
        >
          {EDITOR_COPY.dontSave}
        </button>
        <button
          ref={saveButton}
          type="button"
          className="tree-dialog-button is-primary"
          data-testid="unsaved-save"
          disabled={props.saving}
          onClick={() => props.onSave()}
        >
          {EDITOR_COPY.saveAndClose}
        </button>
      </div>
    </dialog>
  );
}
