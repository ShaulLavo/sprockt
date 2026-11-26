// Landing-page row UI for workspaces whose import, share link, or template seed did not finish.
// Built on PR 4's `readIncomplete`, `retryPath`, `INCOMPLETE`, and `COPY` while keeping
// `waffle/runtime.ts` unloaded on `/` via runtime-free storage discovery/deletion.
import { useEffect, useState } from "react";
import { COPY, fill } from "../importer/copy";
import { readIncomplete, retryPath, type OpenIdle } from "../importer/incomplete";
import { INCOMPLETE, WORKSPACE_META_PATH, type WorkspaceMeta } from "../importer/metadata";
import { LANDING_COPY } from "./copy";
import { Icon } from "./icons";
import { deleteStoredWorkspace } from "./workspaces";

export interface IncompleteRowProps {
  readonly id: string;
  readonly onDeleted: () => void;
  /** Already-loaded metadata from workspace discovery so the switcher avoids probing IndexedDB twice. */
  readonly meta?: WorkspaceMeta;
  /** When true, skips the idle probe because the parent already determined the workspace state. */
  readonly skipProbe?: boolean;
  /** Retries an unfinished template seed in place. */
  readonly onRetryTemplate?: (meta: WorkspaceMeta) => Promise<void>;
}

const encoder = new TextEncoder();

const lightweightOpenIdle: OpenIdle = async (selection) => {
  const { inspectIdleWorkspaceMeta } = await import("./storage-discovery");
  const outcome = await inspectIdleWorkspaceMeta(selection.name, WORKSPACE_META_PATH);
  if (outcome.status === "busy" || outcome.status === "missing") return outcome.status;
  const bytes = outcome.rawMeta !== undefined ? encoder.encode(outcome.rawMeta) : undefined;
  return {
    async readFile(path: string): Promise<Uint8Array | undefined> {
      return path === WORKSPACE_META_PATH ? bytes : undefined;
    },
    async close(): Promise<void> {
      // inspectIdleWorkspaceMeta already released the lock and closed the database.
    },
  };
};

/** Focuses a just-mounted element once the current render settles. */
function focusOnMount(el: HTMLElement | null): void {
  if (el) queueMicrotask(() => el.focus());
}

interface Probe {
  readonly id: string;
  readonly meta: WorkspaceMeta | undefined;
}

/** Reads the workspace's metadata from storage when `id` is set; undefined until it answers. */
function useProbe(id: string | undefined): WorkspaceMeta | undefined {
  const [probe, setProbe] = useState<Probe | undefined>();
  useEffect(() => {
    if (id === undefined) return;
    let live = true;
    const run = async (): Promise<void> => {
      // A failed probe shows no row, as before.
      const meta = await readIncomplete(id, lightweightOpenIdle).catch(() => undefined);
      if (live) setProbe({ id, meta });
    };
    void run();
    return () => {
      live = false;
    };
  }, [id]);
  return probe !== undefined && probe.id === id ? probe.meta : undefined;
}

function incompleteMeta(
  props: IncompleteRowProps,
  probed: WorkspaceMeta | undefined,
): WorkspaceMeta | undefined {
  if (props.meta !== undefined) return props.meta.state === INCOMPLETE ? props.meta : undefined;
  if (props.skipProbe) return undefined;
  return probed;
}

export function IncompleteRow(props: IncompleteRowProps) {
  const probed = useProbe(props.skipProbe || props.meta !== undefined ? undefined : props.id);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function remove(): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      const result = await deleteStoredWorkspace(props.id).catch(() => "failed" as const);
      if (result === "deleted" || result === "missing") {
        props.onDeleted();
        return;
      }
      setConfirming(false);
      setError(result === "busy" ? COPY.errors.deleteBusy : COPY.errors.deleteFailed);
    } finally {
      setBusy(false);
    }
  }

  async function retryTemplate(meta: WorkspaceMeta): Promise<void> {
    if (!props.onRetryTemplate) return;
    setBusy(true);
    setError(undefined);
    try {
      await props.onRetryTemplate(meta);
    } catch {
      setError(LANDING_COPY.recentBusyRetry);
    } finally {
      setBusy(false);
    }
  }

  const meta = incompleteMeta(props, probed);
  if (!meta) return null;

  const href = retryPath(props.id, meta);
  const canRetryTemplate = !href && !meta.source && Boolean(props.onRetryTemplate);
  const label = meta.source ? COPY.importer.importIncomplete : LANDING_COPY.recentIncompleteSeeding;
  const discardTitle = fill(COPY.confirm.discardTitle, { name: meta.name });

  const confirm = (
    <div
      className="lp-ws-confirm"
      role="alertdialog"
      aria-label={discardTitle}
      data-testid={`workspace-confirm-delete-${props.id}`}
    >
      <span className="lp-ws-confirm-text">{discardTitle}</span>
      <div className="lp-ws-confirm-actions">
        <button
          type="button"
          className="lp-ws-btn lp-ws-btn-danger"
          disabled={busy}
          data-testid="incomplete-confirm-delete"
          onClick={() => void remove()}
        >
          {COPY.confirm.discardConfirm}
        </button>
        <button
          type="button"
          className="lp-ws-btn"
          disabled={busy}
          data-testid={`workspace-delete-cancel-${props.id}`}
          ref={focusOnMount}
          onClick={() => setConfirming(false)}
        >
          {COPY.confirm.cancel}
        </button>
      </div>
    </div>
  );

  const actions = (
    <>
      <span className="lp-ws-incomplete" data-testid={`workspace-incomplete-${props.id}`}>
        {label}
      </span>
      <div className="lp-ws-incomplete-actions">
        {href ? (
          <a className="lp-ws-btn" href={href} data-testid="incomplete-retry">
            {COPY.importer.tryAgain}
          </a>
        ) : null}
        {canRetryTemplate ? (
          <button
            type="button"
            className="lp-ws-btn"
            disabled={busy}
            data-testid="incomplete-retry"
            onClick={() => void retryTemplate(meta)}
          >
            {busy ? LANDING_COPY.recentRetrying : LANDING_COPY.recentRetry}
          </button>
        ) : null}
        <button
          type="button"
          className="lp-ws-icon-btn is-danger"
          title={COPY.importer.delete}
          aria-label={`${LANDING_COPY.recentDelete}: ${meta.name}`}
          disabled={busy}
          data-testid="incomplete-delete"
          onClick={() => {
            setError(undefined);
            setConfirming(true);
          }}
        >
          <Icon name="trash" />
        </button>
      </div>
    </>
  );

  return (
    <div className="lp-incomplete-row" data-testid="incomplete-import">
      {confirming ? confirm : actions}
      {error ? (
        <p className="lp-recent-notice" role="alert" data-testid="workspace-notice">
          {error}
        </p>
      ) : null}
    </div>
  );
}
