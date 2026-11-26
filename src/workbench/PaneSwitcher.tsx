// The phone tab bar that picks which pane fills the screen.
import { Icon, type IconName } from "../ui/icons";
import { ui } from "./copy";

/** The panes a phone shows one at a time. */
export type PhonePane = "files" | "code" | "preview" | "terminal";

const PANES: readonly { pane: PhonePane; label: string; icon: IconName }[] = [
  { pane: "files", label: ui.panels.files, icon: "files" },
  { pane: "code", label: ui.panels.code, icon: "code" },
  { pane: "preview", label: ui.panels.preview, icon: "globe" },
  { pane: "terminal", label: ui.panels.terminal, icon: "terminal" },
];

export function PaneSwitcher(props: { pane: PhonePane; onPick(pane: PhonePane): void; dirty: boolean }) {
  return (
    <nav className="wb-switcher" aria-label={ui.workbench.panes} data-testid="pane-switcher">
      {PANES.map((item) => (
        <button
          key={item.pane}
          type="button"
          className="wb-switch"
          aria-pressed={props.pane === item.pane}
          aria-controls={`wb-slot-${item.pane}`}
          onClick={() => props.onPick(item.pane)}
        >
          <Icon name={item.icon} />
          <span>{item.label}</span>
          {item.pane === "code" && props.dirty ? <span className="wb-switch-dot" aria-hidden="true" /> : null}
        </button>
      ))}
    </nav>
  );
}
