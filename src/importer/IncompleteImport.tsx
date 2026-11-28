import { useEffect, useState } from "react";
import { openIdleWorkspace } from "waffle";
import { storageName } from "../workspace/paths";
import { COPY, fill } from "./copy";
import { readIncomplete, retryPath } from "./incomplete";
import type { WorkspaceMeta } from "../workspace/metadata";
import "./importer.css";

/** The unfinished import's metadata of workspace `id`, once read; undefined while reading or when complete. */
function useIncomplete(id: string): WorkspaceMeta | undefined {
  const [meta, setMeta] = useState<{ readonly id: string; readonly meta: WorkspaceMeta | undefined }>();
  useEffect(() => {
    let cancelled = false;
    async function read(): Promise<void> {
      // A workspace whose metadata cannot be read shows nothing, as a complete one does.
      const found = await readIncomplete(id, openIdleWorkspace).catch(() => undefined);
      if (!cancelled) setMeta({ id, meta: found });
    }
    void read();
    return () => {
      cancelled = true;
    };
  }, [id]);
  // What was read for another id says nothing about this one.
  return meta?.id === id ? meta.meta : undefined;
}

/**
 * Shown next to a workspace in the landing list when its import (or share link, or template
 * seed) did not finish: Retry re-runs the import into the same workspace, Delete removes it
 * after a confirmation. Renders nothing for a complete workspace. This is the only way an
 * unfinished workspace is cleaned up; Sprockt never deletes one on its own.
 *
 * Landing list: `<IncompleteImport id={id} onDeleted={refresh} />` inside each row.
 */
export function IncompleteImport(props: { id: string; onDeleted: () => void }) {
  const incomplete = useIncomplete(props.id);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();

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

  if (!incomplete) return null;
  const retry = retryPath(props.id, incomplete);
  const title = fill(COPY.confirm.discardTitle, { name: incomplete.name });

  return (
    <div className="incomplete-import" data-testid="incomplete-import">
      <span className="incomplete-label">{COPY.importer.importIncomplete}</span>
      {retry ? (
        <a className="importer-button" href={retry} data-testid="incomplete-retry">
          {COPY.importer.tryAgain}
        </a>
      ) : null}
      {confirming ? (
        <div className="incomplete-confirm" role="alertdialog" aria-label={title}>
          <strong>{title}</strong>
          <span>{COPY.confirm.discardBody}</span>
          <button
            type="button"
            className="importer-button danger"
            data-testid="incomplete-confirm-delete"
            onClick={() => void remove()}
          >
            {COPY.confirm.discardConfirm}
          </button>
          <button type="button" className="importer-button" onClick={() => setConfirming(false)}>
            {COPY.confirm.cancel}
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="importer-button"
          data-testid="incomplete-delete"
          onClick={() => setConfirming(true)}
        >
          {COPY.importer.delete}
        </button>
      )}
      {error ? (
        <span className="importer-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
