// Local workspace switcher: lists stored IndexedDB workspaces, opens, renames, retries, and deletes them.
// Renders `<IncompleteRow>` (built on PR 4's `readIncomplete` / `retryPath`) for unfinished workspaces.
import { useState } from "react";
import type { WorkspaceMeta } from "../workspace/metadata";
import { templateLabel } from "../templates/metadata";
import { formatRelativeTime } from "../workspace/workspace-meta";
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

/** Focuses a just-mounted element once the current render settles. */
function focusOnMount(el: HTMLElement | null): void {
  if (el) queueMicrotask(() => el.focus());
}

function rowClass(menuOpen: boolean, incomplete: boolean): string {
  if (menuOpen) return "lp-ws is-menu-open";
  return incomplete ? "lp-ws is-incomplete" : "lp-ws";
}

/** "Open in another tab" when it is, else when it was last opened, in the given class. */
function LastSeen(props: {
  readonly ws: StoredWorkspaceSummary;
  readonly liveClass: string;
  readonly liveTestId: string;
  readonly whenClass: string;
}) {
  const { ws } = props;
  if (ws.openInOtherTab) {
    return (
      <span className={props.liveClass} data-testid={props.liveTestId}>
        {LANDING_COPY.recentOpenElsewhere}
      </span>
    );
  }
  if (!ws.lastOpened) return null;
  return <span className={props.whenClass}>{formatRelativeTime(ws.lastOpened)}</span>;
}

export function WorkspaceSwitcher(props: WorkspaceSwitcherProps) {
  const [editingId, setEditingId] = useState<string | undefined>();
  const [draftName, setDraftName] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | undefined>();
  const [menuId, setMenuId] = useState<string | undefined>();
  const [busyId, setBusyId] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();

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

  function startDelete(id: string): void {
    setEditingId(undefined);
    setMenuId(undefined);
    setNotice(undefined);
    setConfirmDeleteId(id);
  }

  async function commitRename(id: string): Promise<void> {
    const trimmed = draftName.trim();
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
        return;
      }
      if (result.status === "missing") {
        setEditingId(undefined);
        props.onRefresh();
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
    } catch {
      setConfirmDeleteId(undefined);
      setNotice(LANDING_COPY.recentDeleteFailed);
    } finally {
      setBusyId(undefined);
    }
  }

  async function retryTemplateWorkspace(id: string, meta: WorkspaceMeta): Promise<void> {
    const customName = meta.defaultName ? undefined : meta.name;
    const result = await retryStoredWorkspace(id, meta.template ?? "blank", customName);
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

  function renderConfirmDelete(ws: StoredWorkspaceSummary) {
    const isBusy = busyId === ws.id;
    return (
      <div className="lp-ws-confirm" data-testid={`workspace-confirm-delete-${ws.id}`}>
        <span className="lp-ws-confirm-text">Delete {ws.name}?</span>
        <div className="lp-ws-confirm-actions">
          <button
            type="button"
            className="lp-ws-btn lp-ws-btn-danger"
            disabled={isBusy}
            data-testid={`workspace-delete-confirm-${ws.id}`}
            onClick={() => void confirmDelete(ws.id)}
          >
            {LANDING_COPY.recentConfirmDelete}
          </button>
          <button
            type="button"
            className="lp-ws-btn"
            disabled={isBusy}
            data-testid={`workspace-delete-cancel-${ws.id}`}
            ref={focusOnMount}
            onClick={() => setConfirmDeleteId(undefined)}
          >
            {LANDING_COPY.recentCancel}
          </button>
        </div>
      </div>
    );
  }

  function renderRename(ws: StoredWorkspaceSummary) {
    const isBusy = busyId === ws.id;
    return (
      <form
        className="lp-ws-rename-form"
        onSubmit={(event) => {
          event.preventDefault();
          void commitRename(ws.id);
        }}
      >
        <label className="lp-sr-only" htmlFor={`rename-${ws.id}`}>
          {LANDING_COPY.recentRename}
        </label>
        <input
          id={`rename-${ws.id}`}
          type="text"
          className="lp-ws-rename-input"
          value={draftName}
          maxLength={64}
          ref={focusOnMount}
          data-testid={`workspace-rename-input-${ws.id}`}
          onChange={(event) => setDraftName(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") cancelRename();
          }}
        />
        <button
          type="submit"
          className="lp-ws-icon-btn is-ok"
          aria-label={LANDING_COPY.recentSave}
          disabled={isBusy || !draftName.trim()}
          data-testid={`workspace-rename-save-${ws.id}`}
        >
          <Icon name="check" />
        </button>
        <button
          type="button"
          className="lp-ws-icon-btn"
          aria-label={LANDING_COPY.recentCancel}
          disabled={isBusy}
          data-testid={`workspace-rename-cancel-${ws.id}`}
          onClick={cancelRename}
        >
          <Icon name="x" />
        </button>
      </form>
    );
  }

  function renderIncomplete(ws: StoredWorkspaceSummary) {
    return (
      <div className="lp-ws-incomplete-wrap">
        <div className="lp-ws-main lp-ws-main-static">
          <BrandLogoTile templateId={ws.template} class="lp-ws-logo" />
          <span className="lp-ws-text">
            <span className="lp-ws-name">{ws.name}</span>
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
    );
  }

  function renderReady(ws: StoredWorkspaceSummary) {
    const isMenuOpen = menuId === ws.id;
    return (
      <>
        <button
          type="button"
          className="lp-ws-main"
          data-testid={`workspace-open-${ws.id}`}
          onClick={() => openWorkspace(ws.id)}
        >
          <BrandLogoTile templateId={ws.template} class="lp-ws-logo" />
          <span className="lp-ws-text">
            <span className="lp-ws-name">{ws.name}</span>
            <span className="lp-ws-meta-row">
              <span className="lp-ws-meta">{templateLabel(ws.template)}</span>
              <LastSeen
                ws={ws}
                liveClass="lp-live lp-live-inline"
                liveTestId={`workspace-live-phone-${ws.id}`}
                whenClass="lp-ws-when-phone"
              />
            </span>
          </span>
          <LastSeen
            ws={ws}
            liveClass="lp-live lp-live-desktop"
            liveTestId={`workspace-live-${ws.id}`}
            whenClass="lp-ws-when"
          />
        </button>

        <IncompleteRow id={ws.id} meta={ws.meta} skipProbe onDeleted={props.onRefresh} />

        {/* Desktop: reveal actions on hover/focus; Touch: single "more" button */}
        <div className="lp-ws-actions">
          <button
            type="button"
            className="lp-ws-icon-btn lp-ws-more-btn"
            aria-label={`${LANDING_COPY.recentMore}: ${ws.name}`}
            aria-expanded={isMenuOpen}
            data-testid={`workspace-more-${ws.id}`}
            onClick={() => setMenuId(isMenuOpen ? undefined : ws.id)}
          >
            <Icon name="more" />
          </button>
          <div className="lp-ws-inline-actions">
            <button
              type="button"
              className="lp-ws-icon-btn"
              title={LANDING_COPY.recentRename}
              aria-label={`${LANDING_COPY.recentRename}: ${ws.name}`}
              data-testid={`workspace-rename-${ws.id}`}
              onClick={() => startRename(ws)}
            >
              <Icon name="pencil" />
            </button>
            <button
              type="button"
              className="lp-ws-icon-btn is-danger"
              title={LANDING_COPY.recentDelete}
              aria-label={`${LANDING_COPY.recentDelete}: ${ws.name}`}
              data-testid={`workspace-delete-${ws.id}`}
              onClick={() => startDelete(ws.id)}
            >
              <Icon name="trash" />
            </button>
          </div>
        </div>
      </>
    );
  }

  function renderBody(ws: StoredWorkspaceSummary) {
    if (editingId === ws.id) return renderRename(ws);
    if (confirmDeleteId === ws.id) return renderConfirmDelete(ws);
    return ws.state !== undefined ? renderIncomplete(ws) : renderReady(ws);
  }

  function renderRow(ws: StoredWorkspaceSummary) {
    return (
      <li
        key={ws.id}
        className={rowClass(menuId === ws.id, ws.state !== undefined)}
        data-testid={`workspace-row-${ws.id}`}
      >
        <span className="lp-sr-only">{ws.id}</span>
        {renderBody(ws)}
      </li>
    );
  }

  return (
    <aside className="lp-recent-col" aria-labelledby="recent-title">
      <div className="lp-recent-head">
        <h3 id="recent-title">{LANDING_COPY.recentTitle}</h3>
        <p>{LANDING_COPY.recentNote}</p>
      </div>
      <div className="lp-recent">
        {notice ? (
          <p className="lp-recent-notice" role="status" data-testid="workspace-notice">
            {notice}
          </p>
        ) : null}

        {props.workspaces.length > 0 ? (
          <ul className="lp-ws-list" data-testid="workspace-list">
            {props.workspaces.map(renderRow)}
          </ul>
        ) : (
          <div className="lp-recent-empty" data-testid="workspace-empty">
            <p>{props.loading ? LANDING_COPY.recentChecking : LANDING_COPY.recentEmpty}</p>
          </div>
        )}

        <div className="lp-recent-foot">
          <Icon name="drive" />
          <span>{LANDING_COPY.recentStorage}</span>
        </div>
      </div>
    </aside>
  );
}
