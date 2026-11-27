// Resize handle between panes backed by `@shaulavo/workbench`'s WAI-ARIA `Splitter`.
import type { GlobalPaneGeometry, Space } from "@shaulavo/workbench/core";
import { Splitter as WorkbenchSplitter } from "@shaulavo/workbench";
import { useValue } from "../lib/react";
import type { LayoutStore } from "./layout-store";
import type { PaneLayout, Splitter as SplitterName, TerminalState } from "./layout";

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

export function Splitter(props: SplitterProps) {
  const layout = useValue(props.store.layout);
  return (
    <WorkbenchSplitter
      splitter={props.splitter}
      label={props.label}
      controls={props.controls}
      geometry={toGeometry(layout)}
      valueNow={props.valueNow}
      measureSpace={props.measureSpace}
      measurePaneSize={props.measureSize}
      onPreviewGeometry={(next) => props.store.show(fromGeometry(next, props.store.layout(), props.splitter))}
      onCommitGeometry={(next) => props.store.set(fromGeometry(next, props.store.layout(), props.splitter))}
      onDraggingChange={props.onDragging}
      className={`wb-splitter-${props.splitter}`}
    />
  );
}
