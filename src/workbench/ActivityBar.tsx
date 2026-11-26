// The desktop activity bar: one toggle per pane that can be closed.
import { useValue } from "../lib/react";
import { Icon, type IconName } from "../ui/icons";
import { ui } from "./copy";
import { isOpen, setOpen, type Splitter } from "./layout";
import type { LayoutStore } from "./layout-store";

const ITEMS: readonly { pane: Splitter; label: string; icon: IconName }[] = [
  { pane: "explorer", label: ui.panels.explorer, icon: "files" },
  { pane: "preview", label: ui.panels.preview, icon: "globe" },
  { pane: "terminal", label: ui.panels.terminal, icon: "terminal" },
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
            onClick={() => props.layout.set(setOpen(props.layout.layout(), item.pane, !open))}
          >
            <Icon name={item.icon} />
          </button>
        );
      })}
    </nav>
  );
}
