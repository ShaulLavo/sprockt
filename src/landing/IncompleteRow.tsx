// Landing-page row UI for workspaces whose import, share link, or template seed did not finish.
// Built on PR 4's `readIncomplete`, `retryPath`, `INCOMPLETE`, and `COPY` while keeping
// `waffle/runtime.ts` unloaded on `/` via runtime-free storage discovery/deletion.
import { createResource, createSignal, Show } from "solid-js";
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

export function IncompleteRow(props: IncompleteRowProps) {
  const [probed] = createResource(
    () => (props.skipProbe || props.meta !== undefined ? undefined : props.id),
    (id) => readIncomplete(id, lightweightOpenIdle),
  );
  const [confirming, setConfirming] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | undefined>();

  const incomplete = (): WorkspaceMeta | undefined => {
    if (props.meta !== undefined) return props.meta.state === INCOMPLETE ? props.meta : undefined;
    if (props.skipProbe) return undefined;
    return probed.state === "ready" ? probed() : undefined;
  };

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

  return (
    <Show when={incomplete()}>
      {(meta) => {
        const href = () => retryPath(props.id, meta());
        const canRetryTemplate = () => !href() && !meta().source && Boolean(props.onRetryTemplate);
        const label = () =>
          meta().source ? COPY.importer.importIncomplete : LANDING_COPY.recentIncompleteSeeding;

        return (
          <div class="lp-incomplete-row" data-testid="incomplete-import">
            <Show
              when={confirming()}
              fallback={
                <>
                  <span class="lp-ws-incomplete" data-testid={`workspace-incomplete-${props.id}`}>
                    {label()}
                  </span>
                  <div class="lp-ws-incomplete-actions">
                    <Show when={href()}>
                      {(path) => (
                        <a class="lp-ws-btn" href={path()} data-testid="incomplete-retry">
                          {COPY.importer.tryAgain}
                        </a>
                      )}
                    </Show>
                    <Show when={canRetryTemplate()}>
                      <button
                        type="button"
                        class="lp-ws-btn"
                        disabled={busy()}
                        data-testid="incomplete-retry"
                        onClick={() => void retryTemplate(meta())}
                      >
                        {busy() ? LANDING_COPY.recentRetrying : LANDING_COPY.recentRetry}
                      </button>
                    </Show>
                    <button
                      type="button"
                      class="lp-ws-icon-btn is-danger"
                      title={COPY.importer.delete}
                      aria-label={`${LANDING_COPY.recentDelete}: ${meta().name}`}
                      disabled={busy()}
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
              }
            >
              <div
                class="lp-ws-confirm"
                role="alertdialog"
                aria-label={fill(COPY.confirm.discardTitle, { name: meta().name })}
                data-testid={`workspace-confirm-delete-${props.id}`}
              >
                <span class="lp-ws-confirm-text">
                  {fill(COPY.confirm.discardTitle, { name: meta().name })}
                </span>
                <div class="lp-ws-confirm-actions">
                  <button
                    type="button"
                    class="lp-ws-btn lp-ws-btn-danger"
                    disabled={busy()}
                    data-testid="incomplete-confirm-delete"
                    onClick={() => void remove()}
                  >
                    {COPY.confirm.discardConfirm}
                  </button>
                  <button
                    type="button"
                    class="lp-ws-btn"
                    disabled={busy()}
                    data-testid={`workspace-delete-cancel-${props.id}`}
                    ref={(el) => queueMicrotask(() => el.focus())}
                    onClick={() => setConfirming(false)}
                  >
                    {COPY.confirm.cancel}
                  </button>
                </div>
              </div>
            </Show>
            <Show when={error()}>
              {(message) => (
                <p class="lp-recent-notice" role="alert" data-testid="workspace-notice">
                  {message()}
                </p>
              )}
            </Show>
          </div>
        );
      }}
    </Show>
  );
}
