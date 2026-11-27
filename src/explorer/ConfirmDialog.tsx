// Modal confirmation dialog backed by `@shaulavo/workbench`'s Base UI `ConfirmDialog`.
import { ConfirmDialog as WorkbenchConfirmDialog } from "@shaulavo/workbench";

export function ConfirmDialog(props: {
  title: string;
  body: string;
  confirm: string;
  cancel: string;
  onConfirm(): void;
  onCancel(): void;
}) {
  return (
    <WorkbenchConfirmDialog
      open={true}
      danger={true}
      title={props.title}
      description={props.body}
      confirmLabel={props.confirm}
      cancelLabel={props.cancel}
      onConfirm={props.onConfirm}
      onCancel={props.onCancel}
    />
  );
}
