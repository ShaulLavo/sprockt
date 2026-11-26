// The status bar: branch, save state, items other slices add, and how many tabs share this
// workspace. The dev server shows in the title bar instead.
import type { Accessor } from "../lib/reactive";
import { useValue } from "../lib/react";
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
  const { item } = props;
  const body = (
    <>
      {item.icon ? <Icon name={item.icon} /> : null}
      <span>{item.text}</span>
    </>
  );
  const onClick = item.onClick;
  if (!onClick) {
    return (
      <span className="sb-item" data-tone={item.tone} title={item.title} data-status={item.id}>
        {body}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="sb-item sb-button"
      data-tone={item.tone}
      title={item.title}
      data-status={item.id}
      onClick={() => onClick()}
    >
      {body}
    </button>
  );
}

const entries = (items: readonly StatusEntry[]) => items.map((item) => <Entry key={item.id} item={item} />);

export function StatusBar(props: { tabs: Accessor<number> }) {
  const { files, status } = useWorkspace();
  const items = useValue(status.items);
  const saveState = useValue(files.saveState);
  const tabs = useValue(props.tabs);
  const shown = items.filter((item) => item.id !== STATUS_SLOT.devServer);
  const branch = shown.filter((item) => item.id === STATUS_SLOT.branch);
  const start = shown.filter((item) => item.side !== "end" && item.id !== STATUS_SLOT.branch);
  const end = shown.filter((item) => item.side === "end");

  return (
    <footer className="wb-status" data-testid="status-bar">
      {entries(branch)}
      {/* The text is the raw state ("saved"), which tests and close-tab prompts wait on. */}
      <span className="sb-item sb-save" data-state={saveState} title={SAVE_TITLE[saveState]}>
        <Icon name={SAVE_ICON[saveState]} />
        <span data-testid="save-state">{saveState}</span>
      </span>
      {entries(start)}
      <span className="sb-fill" />
      {entries(end)}
      {tabs > 1 ? (
        <span
          className="sb-item sb-live"
          title={fill(ui.tabs.liveBadgeTooltip, { count: tabs })}
          data-testid="tab-sharing"
        >
          <span className="wb-live-dot" aria-hidden="true" />
          {fill(ui.tabs.liveBadge, { count: tabs })}
        </span>
      ) : null}
    </footer>
  );
}
