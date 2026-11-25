import { onMount } from "solid-js";

/** A modal question with a cancel button that has focus first, so Enter never destroys anything. */
export function ConfirmDialog(props: {
  title: string;
  body: string;
  confirm: string;
  cancel: string;
  onConfirm(): void;
  onCancel(): void;
}) {
  let dialog: HTMLDialogElement | undefined;
  let cancel: HTMLButtonElement | undefined;
  onMount(() => {
    dialog?.showModal();
    cancel?.focus();
  });
  return (
    <dialog
      ref={(element) => (dialog = element)}
      class="tree-dialog"
      data-testid="confirm-dialog"
      aria-labelledby="tree-dialog-title"
      aria-describedby="tree-dialog-body"
      onCancel={(event) => {
        event.preventDefault();
        props.onCancel();
      }}
      onClose={props.onCancel}
    >
      <h2 id="tree-dialog-title">{props.title}</h2>
      <p id="tree-dialog-body">{props.body}</p>
      <div class="tree-dialog-actions">
        <button
          ref={(element) => (cancel = element)}
          type="button"
          class="tree-dialog-button"
          onClick={props.onCancel}
        >
          {props.cancel}
        </button>
        <button
          type="button"
          class="tree-dialog-button danger"
          data-testid="confirm-delete"
          onClick={props.onConfirm}
        >
          {props.confirm}
        </button>
      </div>
    </dialog>
  );
}
