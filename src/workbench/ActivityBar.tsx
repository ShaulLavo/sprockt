// The desktop activity bar: one toggle per pane that can be closed.
import { For } from "solid-js";
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
  return (
    <nav class="wb-activity" aria-label={ui.workbench.views}>
      <For each={ITEMS}>
        {(item) => {
          const open = () => isOpen(props.layout.layout(), item.pane);
          return (
            <button
              type="button"
              class="wb-act"
              aria-label={item.label}
              title={item.label}
              aria-pressed={open()}
              data-testid={`toggle-${item.pane}`}
              onClick={() => props.layout.set(setOpen(props.layout.layout(), item.pane, !open()))}
            >
              <Icon name={item.icon} />
            </button>
          );
        }}
      </For>
    </nav>
  );
}
