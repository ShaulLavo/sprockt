// Three-way unsaved changes dialog backed by `@shaulavo/workbench-ui`'s Base UI `UnsavedChangesDialog`.
import { UnsavedChangesDialog as WorkbenchUnsavedChangesDialog } from "@shaulavo/workbench-ui";
import { originalPath } from "./buffers";
import { EDITOR_COPY } from "./copy";

const basename = (path: string) => {
  const real = originalPath(path);
  return real.slice(real.lastIndexOf("/") + 1);
};

export function UnsavedChangesDialog(props: {
  readonly paths: readonly string[];
  readonly saving?: boolean;
  readonly error?: string;
  onSave(): void;
  onDiscard(): void;
  onCancel(): void;
}) {
  return (
    <WorkbenchUnsavedChangesDialog
      open={true}
      files={props.paths.map(basename)}
      saving={props.saving}
      error={props.error}
      saveLabel={EDITOR_COPY.saveAndClose}
      discardLabel={EDITOR_COPY.dontSave}
      cancelLabel={EDITOR_COPY.cancel}
      onSave={props.onSave}
      onDiscard={props.onDiscard}
      onCancel={props.onCancel}
    />
  );
}
