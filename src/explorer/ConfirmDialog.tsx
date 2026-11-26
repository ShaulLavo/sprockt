import { useEffect, useRef } from "react";

/** A modal question with a cancel button that has focus first, so Enter never destroys anything. */
export function ConfirmDialog(props: {
  title: string;
  body: string;
  confirm: string;
  cancel: string;
  onConfirm(): void;
  onCancel(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
    cancel.current?.focus();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="tree-dialog"
      data-testid="confirm-dialog"
      aria-labelledby="tree-dialog-title"
      aria-describedby="tree-dialog-body"
      onCancel={(event) => {
        event.preventDefault();
        props.onCancel();
      }}
      onClose={() => props.onCancel()}
    >
      <h2 id="tree-dialog-title">{props.title}</h2>
      <p id="tree-dialog-body">{props.body}</p>
      <div className="tree-dialog-actions">
        <button ref={cancel} type="button" className="tree-dialog-button" onClick={() => props.onCancel()}>
          {props.cancel}
        </button>
        <button
          type="button"
          className="tree-dialog-button danger"
          data-testid="confirm-delete"
          onClick={() => props.onConfirm()}
        >
          {props.confirm}
        </button>
      </div>
    </dialog>
  );
}
