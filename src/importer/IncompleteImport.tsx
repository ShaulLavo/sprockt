import { createResource, createSignal, Show } from "solid-js";
import { openIdleWorkspace } from "waffle";
import { storageName } from "../workspace/paths";
import { COPY, fill } from "./copy";
import { readIncomplete, retryPath } from "./incomplete";
import "./importer.css";

/**
 * Shown next to a workspace in the landing list when its import (or share link, or template
 * seed) did not finish: Retry re-runs the import into the same workspace, Delete removes it
 * after a confirmation. Renders nothing for a complete workspace. This is the only way an
 * unfinished workspace is cleaned up; Sprockt never deletes one on its own.
 *
 * Landing list: `<IncompleteImport id={id} onDeleted={refresh} />` inside each row.
 */
export function IncompleteImport(props: { id: string; onDeleted: () => void }) {
  const [meta] = createResource(
    () => props.id,
    (id) => readIncomplete(id, openIdleWorkspace),
  );
  const [confirming, setConfirming] = createSignal(false);
  const [error, setError] = createSignal<string>();

  async function remove(): Promise<void> {
    setError(undefined);
    // The one deletion every workspace goes through: it forgets the IDE's own records of the
    // storage in the same step, under the storage's locks (workspace/storage-lifecycle.ts).
    const { deleteIdleWorkspaceStorage } = await import("../landing/storage-discovery");
    const result = await deleteIdleWorkspaceStorage(storageName(props.id)).catch(() => "failed");
    if (result === "deleted" || result === "missing") {
      props.onDeleted();
      return;
    }
    setConfirming(false);
    setError(COPY.errors.deleteBusy);
  }

  return (
    <Show when={meta.state === "ready" && meta()}>
      {(incomplete) => (
        <div class="incomplete-import" data-testid="incomplete-import">
          <span class="incomplete-label">{COPY.importer.importIncomplete}</span>
          <Show when={retryPath(props.id, incomplete())}>
            {(path) => (
              <a class="importer-button" href={path()} data-testid="incomplete-retry">
                {COPY.importer.tryAgain}
              </a>
            )}
          </Show>
          <Show
            when={confirming()}
            fallback={
              <button
                type="button"
                class="importer-button"
                data-testid="incomplete-delete"
                onClick={() => setConfirming(true)}
              >
                {COPY.importer.delete}
              </button>
            }
          >
            <div
              class="incomplete-confirm"
              role="alertdialog"
              aria-label={fill(COPY.confirm.discardTitle, { name: incomplete().name })}
            >
              <strong>{fill(COPY.confirm.discardTitle, { name: incomplete().name })}</strong>
              <span>{COPY.confirm.discardBody}</span>
              <button
                type="button"
                class="importer-button danger"
                data-testid="incomplete-confirm-delete"
                onClick={() => void remove()}
              >
                {COPY.confirm.discardConfirm}
              </button>
              <button type="button" class="importer-button" onClick={() => setConfirming(false)}>
                {COPY.confirm.cancel}
              </button>
            </div>
          </Show>
          <Show when={error()}>
            {(message) => (
              <span class="importer-error" role="alert">
                {message()}
              </span>
            )}
          </Show>
        </div>
      )}
    </Show>
  );
}
