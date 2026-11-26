// The desktop activity bar: one toggle per pane that can be closed.
import { useValue } from "../lib/react";
import { Icon, type IconName } from "../ui/icons";
import { ui } from "./copy";
import { focusPane } from "./focus";
import { isOpen, setOpen, type Splitter } from "./layout";
import type { LayoutStore } from "./layout-store";
import type { PhonePane } from "./PaneSwitcher";

const ITEMS: readonly { pane: Splitter; slot: PhonePane; label: string; icon: IconName }[] = [
  { pane: "explorer", slot: "files", label: ui.panels.explorer, icon: "files" },
  { pane: "preview", slot: "preview", label: ui.panels.preview, icon: "globe" },
  { pane: "terminal", slot: "terminal", label: ui.panels.terminal, icon: "terminal" },
];

export function ActivityBar(props: { layout: LayoutStore }) {
  const layout = useValue(props.layout.layout);
  return (
    <nav className="wb-activity" aria-label={ui.workbench.views}>
      {ITEMS.map((item) => {
        const open = isOpen(layout, item.pane);
        return (
          <button
            key={item.pane}
            type="button"
            className="wb-act"
            aria-label={item.label}
            title={item.label}
            aria-pressed={open}
            data-pane={item.pane}
            data-testid={`toggle-${item.pane}`}
            onClick={() => {
              const nextOpen = !open;
              props.layout.set(setOpen(props.layout.layout(), item.pane, nextOpen));
              queueMicrotask(() => focusPane(nextOpen ? item.slot : "code"));
            }}
          >
            <Icon name={item.icon} />
          </button>
        );
      })}
    </nav>
  );
}
