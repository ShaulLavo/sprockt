// The status bar: branch, save state, items other slices add, and how many tabs share this
// workspace. The dev server shows in the title bar instead.
import { For, Show, type Accessor } from "solid-js";
import { fill } from "../ui/format";
import { Icon, type IconName } from "../ui/icons";
import type { SaveState } from "../files/service";
import { useWorkspace } from "../workspace/session";
import { ui } from "./copy";
import { STATUS_SLOT, type StatusEntry } from "./slots";

const SAVE_TITLE: Readonly<Record<SaveState, string>> = {
  saved: ui.status.saved,
  saving: ui.status.saving,
  failed: ui.errors.saveFailed,
};

const SAVE_ICON: Readonly<Record<SaveState, IconName>> = { saved: "check", saving: "drive", failed: "alert" };

function Entry(props: { item: StatusEntry }) {
  const body = () => (
    <>
      <Show when={props.item.icon}>{(icon) => <Icon name={icon()} />}</Show>
      <span>{props.item.text}</span>
    </>
  );
  return (
    <Show
      when={props.item.onClick}
      fallback={
        <span
          class="sb-item"
          data-tone={props.item.tone}
          title={props.item.title}
          data-status={props.item.id}
        >
          {body()}
        </span>
      }
    >
      {(onClick) => (
        <button
          type="button"
          class="sb-item sb-button"
          data-tone={props.item.tone}
          title={props.item.title}
          data-status={props.item.id}
          onClick={() => onClick()()}
        >
          {body()}
        </button>
      )}
    </Show>
  );
}

export function StatusBar(props: { tabs: Accessor<number> }) {
  const { files, status } = useWorkspace();
  const shown = () => status.items().filter((item) => item.id !== STATUS_SLOT.devServer);
  const branch = () => shown().filter((item) => item.id === STATUS_SLOT.branch);
  const start = () => shown().filter((item) => item.side !== "end" && item.id !== STATUS_SLOT.branch);
  const end = () => shown().filter((item) => item.side === "end");

  return (
    <footer class="wb-status" data-testid="status-bar">
      <For each={branch()}>{(item) => <Entry item={item} />}</For>
      {/* The text is the raw state ("saved"), which tests and close-tab prompts wait on. */}
      <span class="sb-item sb-save" data-state={files.saveState()} title={SAVE_TITLE[files.saveState()]}>
        <Icon name={SAVE_ICON[files.saveState()]} />
        <span data-testid="save-state">{files.saveState()}</span>
      </span>
      <For each={start()}>{(item) => <Entry item={item} />}</For>
      <span class="sb-fill" />
      <For each={end()}>{(item) => <Entry item={item} />}</For>
      <Show when={props.tabs() > 1}>
        <span
          class="sb-item sb-live"
          title={fill(ui.tabs.liveBadgeTooltip, { count: props.tabs() })}
          data-testid="tab-sharing"
        >
          <span class="wb-live-dot" aria-hidden="true" />
          {fill(ui.tabs.liveBadge, { count: props.tabs() })}
        </span>
      </Show>
    </footer>
  );
}
