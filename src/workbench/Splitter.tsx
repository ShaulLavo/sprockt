// Resize handle between panes backed by `@shaulavo/workbench-ui`'s WAI-ARIA `Splitter`.
import type { GlobalPaneGeometry, Space } from "@shaulavo/workbench-core";
import { Splitter as WorkbenchSplitter } from "@shaulavo/workbench-ui";
import { useValue } from "../lib/react";
import type { LayoutStore } from "./layout-store";
import type { PaneLayout, Splitter as SplitterName } from "./layout";

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
    terminalOpen: layout.terminalOpen,
  };
}

function fromGeometry(geometry: GlobalPaneGeometry): PaneLayout {
  return {
    explorer: geometry.explorerWidthPx,
    preview: geometry.previewFraction,
    terminal: geometry.terminalHeightPx,
    explorerOpen: geometry.explorerOpen,
    previewOpen: geometry.previewOpen,
    terminalOpen: geometry.terminalOpen,
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
      onPreviewGeometry={(next) => props.store.show(fromGeometry(next))}
      onCommitGeometry={(next) => props.store.set(fromGeometry(next))}
      onDraggingChange={props.onDragging}
      className={`wb-splitter-${props.splitter}`}
    />
  );
}
