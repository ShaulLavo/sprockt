// Resize handle between panes backed by `@shaulavo/workbench`'s WAI-ARIA `Splitter`.
import { useEffect } from "react";
import type { GlobalPaneGeometry, Space } from "@shaulavo/workbench/core";
import { Splitter as WorkbenchSplitter } from "@shaulavo/workbench";
import { useValue } from "../lib/react";
import type { LayoutStore } from "./layout-store";
import {
  fitLayout,
  handleKeyOf,
  isOpen,
  keyTo,
  setOpen,
  type PaneLayout,
  type Room,
  type Splitter as SplitterName,
  type TerminalState,
} from "./layout";

export interface SplitterProps {
  readonly splitter: SplitterName;
  readonly label: string;
  /** The id of the pane this handle resizes. */
  readonly controls: string;
  readonly store: LayoutStore;
  /** Measures the total workbench space once per drag or key press. */
  measureSpace(): Space;
  /** The pane's size on screen in CSS pixels, read once when a drag starts. */
  measureSize(): number;
  /** The pane's share as rendered, 0 to 100, for assistive technology. */
  readonly valueNow: number;
  onDragging(dragging: boolean): void;
}

function toGeometry(layout: PaneLayout): GlobalPaneGeometry {
  return {
    explorerWidthPx: layout.explorer,
    previewFraction: layout.preview,
    terminalHeightPx: layout.terminal,
    explorerOpen: layout.explorerOpen,
    previewOpen: layout.previewOpen,
    terminalOpen: layout.terminalState === "open",
  };
}

function nextTerminalState(
  geometry: GlobalPaneGeometry,
  previous: PaneLayout,
  splitter: SplitterName,
): TerminalState {
  if (splitter !== "terminal") return previous.terminalState;
  return geometry.terminalOpen ? "open" : "hidden";
}

function fromGeometry(
  geometry: GlobalPaneGeometry,
  previous: PaneLayout,
  splitter: SplitterName,
): PaneLayout {
  return {
    explorer: geometry.explorerWidthPx,
    preview: geometry.previewFraction,
    terminal: geometry.terminalHeightPx,
    explorerOpen: geometry.explorerOpen,
    previewOpen: geometry.previewOpen,
    terminalState: nextTerminalState(geometry, previous, splitter),
  };
}

function splitterRoom(splitter: SplitterName, layout: PaneLayout, space: Space): Room {
  if (splitter === "terminal") return { extent: space.height };
  if (splitter === "preview") {
    const fitted = fitLayout(layout, space);
    return { extent: Math.max(1, space.width - fitted.explorer) };
  }
  return { extent: space.width };
}

function isExpanded(layout: PaneLayout, splitter: SplitterName): boolean {
  if (splitter === "terminal") return layout.terminalState === "open";
  return isOpen(layout, splitter);
}

export function Splitter(props: SplitterProps) {
  const layout = useValue(props.store.layout);
  const { splitter, store, measureSpace } = props;

  // WorkbenchSplitter steps from 0px when a pane is closed/collapsed, so a single 24px arrow step
  // falls below the drag snap-open threshold and commits closed/hidden. Intercept grow/min/shrink
  // keys on collapsed or hidden panes so keyboard expansion always opens cleanly.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.target instanceof Element)) return;
      if (event.target.getAttribute("data-wb-splitter") !== splitter) return;
      const current = store.layout();
      if (isExpanded(current, splitter)) return;
      const action = handleKeyOf(splitter, event.key);
      if (action === "grow" || action === "min") {
        event.preventDefault();
        event.stopPropagation();
        const room = splitterRoom(splitter, current, measureSpace());
        store.set(keyTo(current, splitter, action, room, event.shiftKey));
        return;
      }
      if (action === "shrink" && splitter === "terminal") {
        event.preventDefault();
        event.stopPropagation();
        if (current.terminalState !== "hidden") store.set(setOpen(current, "terminal", false));
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [measureSpace, splitter, store]);

  return (
    <WorkbenchSplitter
      splitter={splitter}
      label={props.label}
      controls={props.controls}
      geometry={toGeometry(layout)}
      valueNow={props.valueNow}
      measureSpace={measureSpace}
      measurePaneSize={props.measureSize}
      onPreviewGeometry={(next) => store.show(fromGeometry(next, store.layout(), splitter))}
      onCommitGeometry={(next) => store.set(fromGeometry(next, store.layout(), splitter))}
      onDraggingChange={props.onDragging}
      className={`wb-splitter-${splitter}`}
    />
  );
}
