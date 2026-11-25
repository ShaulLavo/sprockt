// Local workspace switcher: lists stored IndexedDB workspaces, opens, renames, retries, and deletes them.
// Renders `<IncompleteRow>` (built on PR 4's `readIncomplete` / `retryPath`) for unfinished workspaces.
import { createSignal, For, Show } from "solid-js";
import type { WorkspaceMeta } from "../importer/metadata";
import { templateLabel } from "../templates/metadata";
import { formatRelativeTime } from "../templates/workspace-meta";
import { LANDING_COPY } from "./copy";
import { Icon } from "./icons";
import { IncompleteRow } from "./IncompleteRow";
import { BrandLogoTile } from "./logos";
import {
  deleteStoredWorkspace,
  renameStoredWorkspace,
  retryStoredWorkspace,
  touchWorkspaceHint,
  type StoredWorkspaceSummary,
} from "./workspaces";

export interface WorkspaceSwitcherProps {
  readonly workspaces: readonly StoredWorkspaceSummary[];
  readonly loading: boolean;
  readonly onOpen: (id: string) => void;
  readonly onRefresh: () => void;
}

export function WorkspaceSwitcher(props: WorkspaceSwitcherProps) {
  const [editingId, setEditingId] = createSignal<string | undefined>();
  const [draftName, setDraftName] = createSignal("");
  const [confirmDeleteId, setConfirmDeleteId] = createSignal<string | undefined>();
  const [menuId, setMenuId] = createSignal<string | undefined>();
  const [busyId, setBusyId] = createSignal<string | undefined>();
  const [notice, setNotice] = createSignal<string | undefined>();

  function startRename(ws: StoredWorkspaceSummary): void {
    setConfirmDeleteId(undefined);
    setMenuId(undefined);
    setNotice(undefined);
    setEditingId(ws.id);
    setDraftName(ws.name);
  }

  function cancelRename(): void {
    setEditingId(undefined);
    setDraftName("");
  }

  async function commitRename(id: string): Promise<void> {
    const trimmed = draftName().trim();
    if (!trimmed) return;
    setBusyId(id);
    setNotice(undefined);
    try {
      const result = await renameStoredWorkspace(id, trimmed);
      if (result.status === "renamed") {
        setEditingId(undefined);
        props.onRefresh();
        return;
      }
      if (result.status === "busy") {
        setNotice(LANDING_COPY.recentBusyRename);
        setEditingId(undefined);
      }
    } finally {
      setBusyId(undefined);
    }
  }

  async function confirmDelete(id: string): Promise<void> {
    setBusyId(id);
    setNotice(undefined);
    try {
      const result = await deleteStoredWorkspace(id);
      setConfirmDeleteId(undefined);
      if (result === "busy") {
        setNotice(LANDING_COPY.recentBusyDelete);
        return;
      }
      props.onRefresh();
    } finally {
      setBusyId(undefined);
    }
  }

  async function retryTemplateWorkspace(id: string, meta: WorkspaceMeta): Promise<void> {
    const result = await retryStoredWorkspace(id, meta.template ?? "blank", meta.name);
    if (result.status === "seeded" || result.status === "already-ready") {
      props.onOpen(id);
      return;
    }
    if (result.status === "busy") {
      throw new Error("busy");
    }
    props.onRefresh();
  }

  function openWorkspace(id: string): void {
    touchWorkspaceHint(id);
    props.onOpen(id);
  }

  return (
    <aside class="lp-recent-col" aria-labelledby="recent-title">
      <div class="lp-recent-head">
        <h3 id="recent-title">{LANDING_COPY.recentTitle}</h3>
        <p>{LANDING_COPY.recentNote}</p>
      </div>
      <div class="lp-recent">
        <Show when={notice()}>
          {(message) => (
            <p class="lp-recent-notice" role="status" data-testid="workspace-notice">
              {message()}
            </p>
          )}
        </Show>

        <Show
          when={props.workspaces.length > 0}
          fallback={
            <div class="lp-recent-empty" data-testid="workspace-empty">
              <p>{props.loading ? "Checking local workspaces..." : LANDING_COPY.recentEmpty}</p>
            </div>
          }
        >
          <ul class="lp-ws-list" data-testid="workspace-list">
            <For each={props.workspaces}>
              {(ws) => {
                const isEditing = () => editingId() === ws.id;
                const isConfirmingDelete = () => confirmDeleteId() === ws.id;
                const isMenuOpen = () => menuId() === ws.id;
                const isBusy = () => busyId() === ws.id;
                const isIncomplete = () => ws.state !== undefined;

                return (
                  <li
                    class={
                      isMenuOpen() ? "lp-ws is-menu-open" : isIncomplete() ? "lp-ws is-incomplete" : "lp-ws"
                    }
                    data-testid={`workspace-row-${ws.id}`}
                  >
                    <span class="lp-sr-only">{ws.id}</span>
                    <Show
                      when={!isEditing() && !isConfirmingDelete()}
                      fallback={
                        <Show
                          when={isEditing()}
                          fallback={
                            <div class="lp-ws-confirm" data-testid={`workspace-confirm-delete-${ws.id}`}>
                              <span class="lp-ws-confirm-text">Delete {ws.name}?</span>
                              <div class="lp-ws-confirm-actions">
                                <button
                                  type="button"
                                  class="lp-ws-btn lp-ws-btn-danger"
                                  disabled={isBusy()}
                                  data-testid={`workspace-delete-confirm-${ws.id}`}
                                  onClick={() => void confirmDelete(ws.id)}
                                >
                                  {LANDING_COPY.recentConfirmDelete}
                                </button>
                                <button
                                  type="button"
                                  class="lp-ws-btn"
                                  disabled={isBusy()}
                                  data-testid={`workspace-delete-cancel-${ws.id}`}
                                  ref={(el) => queueMicrotask(() => el.focus())}
                                  onClick={() => setConfirmDeleteId(undefined)}
                                >
                                  {LANDING_COPY.recentCancel}
                                </button>
                              </div>
                            </div>
                          }
                        >
                          <form
                            class="lp-ws-rename-form"
                            onSubmit={(event) => {
                              event.preventDefault();
                              void commitRename(ws.id);
                            }}
                          >
                            <label class="lp-sr-only" for={`rename-${ws.id}`}>
                              {LANDING_COPY.recentRename}
                            </label>
                            <input
                              id={`rename-${ws.id}`}
                              type="text"
                              class="lp-ws-rename-input"
                              value={draftName()}
                              maxLength={64}
                              ref={(el) => queueMicrotask(() => el.focus())}
                              data-testid={`workspace-rename-input-${ws.id}`}
                              onInput={(event) => setDraftName(event.currentTarget.value)}
                              onKeyDown={(event) => {
                                if (event.key === "Escape") cancelRename();
                              }}
                            />
                            <button
                              type="submit"
                              class="lp-ws-icon-btn is-ok"
                              aria-label={LANDING_COPY.recentSave}
                              disabled={isBusy() || !draftName().trim()}
                              data-testid={`workspace-rename-save-${ws.id}`}
                            >
                              <Icon name="check" />
                            </button>
                            <button
                              type="button"
                              class="lp-ws-icon-btn"
                              aria-label={LANDING_COPY.recentCancel}
                              disabled={isBusy()}
                              data-testid={`workspace-rename-cancel-${ws.id}`}
                              onClick={cancelRename}
                            >
                              <Icon name="x" />
                            </button>
                          </form>
                        </Show>
                      }
                    >
                      <Show
                        when={!isIncomplete()}
                        fallback={
                          <div class="lp-ws-incomplete-wrap">
                            <div class="lp-ws-main lp-ws-main-static">
                              <BrandLogoTile templateId={ws.template} class="lp-ws-logo" />
                              <span class="lp-ws-text">
                                <span class="lp-ws-name">{ws.name}</span>
                              </span>
                            </div>
                            <IncompleteRow
                              id={ws.id}
                              meta={ws.meta}
                              skipProbe
                              onDeleted={props.onRefresh}
                              onRetryTemplate={(meta) => retryTemplateWorkspace(ws.id, meta)}
                            />
                          </div>
                        }
                      >
                        <button
                          type="button"
                          class="lp-ws-main"
                          data-testid={`workspace-open-${ws.id}`}
                          onClick={() => openWorkspace(ws.id)}
                        >
                          <BrandLogoTile templateId={ws.template} class="lp-ws-logo" />
                          <span class="lp-ws-text">
                            <span class="lp-ws-name">{ws.name}</span>
                            <span class="lp-ws-meta-row">
                              <span class="lp-ws-meta">{templateLabel(ws.template)}</span>
                              <Show
                                when={ws.openInOtherTab}
                                fallback={
                                  <Show when={ws.lastOpened}>
                                    {(when) => (
                                      <span class="lp-ws-when-phone">{formatRelativeTime(when())}</span>
                                    )}
                                  </Show>
                                }
                              >
                                <span
                                  class="lp-live lp-live-inline"
                                  data-testid={`workspace-live-phone-${ws.id}`}
                                >
                                  {LANDING_COPY.recentOpenElsewhere}
                                </span>
                              </Show>
                            </span>
                          </span>
                          <Show
                            when={ws.openInOtherTab}
                            fallback={
                              <Show when={ws.lastOpened}>
                                {(when) => <span class="lp-ws-when">{formatRelativeTime(when())}</span>}
                              </Show>
                            }
                          >
                            <span class="lp-live lp-live-desktop" data-testid={`workspace-live-${ws.id}`}>
                              {LANDING_COPY.recentOpenElsewhere}
                            </span>
                          </Show>
                        </button>

                        <IncompleteRow id={ws.id} meta={ws.meta} skipProbe onDeleted={props.onRefresh} />

                        {/* Desktop: reveal actions on hover/focus; Touch: single "more" button */}
                        <div class="lp-ws-actions">
                          <button
                            type="button"
                            class="lp-ws-icon-btn lp-ws-more-btn"
                            aria-label={`${LANDING_COPY.recentMore}: ${ws.name}`}
                            aria-expanded={isMenuOpen()}
                            data-testid={`workspace-more-${ws.id}`}
                            onClick={() => setMenuId(isMenuOpen() ? undefined : ws.id)}
                          >
                            <Icon name="more" />
                          </button>
                          <div class="lp-ws-inline-actions">
                            <button
                              type="button"
                              class="lp-ws-icon-btn"
                              title={LANDING_COPY.recentRename}
                              aria-label={`${LANDING_COPY.recentRename}: ${ws.name}`}
                              data-testid={`workspace-rename-${ws.id}`}
                              onClick={() => startRename(ws)}
                            >
                              <Icon name="pencil" />
                            </button>
                            <button
                              type="button"
                              class="lp-ws-icon-btn is-danger"
                              title={LANDING_COPY.recentDelete}
                              aria-label={`${LANDING_COPY.recentDelete}: ${ws.name}`}
                              data-testid={`workspace-delete-${ws.id}`}
                              onClick={() => {
                                setEditingId(undefined);
                                setMenuId(undefined);
                                setNotice(undefined);
                                setConfirmDeleteId(ws.id);
                              }}
                            >
                              <Icon name="trash" />
                            </button>
                          </div>
                        </div>
                      </Show>
                    </Show>
                  </li>
                );
              }}
            </For>
          </ul>
        </Show>

        <div class="lp-recent-foot">
          <Icon name="drive" />
          <span>{LANDING_COPY.recentStorage}</span>
        </div>
      </div>
    </aside>
  );
}
