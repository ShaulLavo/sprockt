// Resize handle between panes backed by `@shaulavo/workbench`'s WAI-ARIA `Splitter`.
import { useRef } from "react";
import { DRAG_THRESHOLD_PX, type GlobalPaneGeometry, type Space } from "@shaulavo/workbench/core";
import { Splitter as WorkbenchSplitter, type SplitterChangeMeta } from "@shaulavo/workbench";
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
  meta: SplitterChangeMeta,
  dragStartState: TerminalState | undefined,
): TerminalState {
  if (splitter !== "terminal") return previous.terminalState;
  if (geometry.terminalOpen) return "open";
  if (
    meta.source === "drag" &&
    dragStartState === "collapsed" &&
    (meta.dragGrowthPx ?? 0) > -DRAG_THRESHOLD_PX
  ) {
    return "collapsed";
  }
  return "hidden";
}

function fromGeometry(
  geometry: GlobalPaneGeometry,
  previous: PaneLayout,
  splitter: SplitterName,
  meta: SplitterChangeMeta,
  dragStartState: TerminalState | undefined,
): PaneLayout {
  return {
    explorer: geometry.explorerWidthPx,
    preview: geometry.previewFraction,
    terminal: geometry.terminalHeightPx,
    explorerOpen: geometry.explorerOpen,
    previewOpen: geometry.previewOpen,
    terminalState: nextTerminalState(geometry, previous, splitter, meta, dragStartState),
  };
}

export function Splitter(props: SplitterProps) {
  const layout = useValue(props.store.layout);
  const dragStartTerminalStateRef = useRef<TerminalState | undefined>(undefined);
  const { splitter, store, onDragging } = props;

  return (
    <WorkbenchSplitter
      splitter={splitter}
      label={props.label}
      controls={props.controls}
      geometry={toGeometry(layout)}
      valueNow={props.valueNow}
      measureSpace={props.measureSpace}
      measurePaneSize={props.measureSize}
      onPreviewGeometry={(next, meta) =>
        store.show(fromGeometry(next, store.layout(), splitter, meta, dragStartTerminalStateRef.current))
      }
      onCommitGeometry={(next, meta) => {
        const dragStartState = dragStartTerminalStateRef.current;
        dragStartTerminalStateRef.current = undefined;
        store.set(fromGeometry(next, store.layout(), splitter, meta, dragStartState));
      }}
      onDraggingChange={(dragging) => {
        if (dragging && splitter === "terminal") {
          dragStartTerminalStateRef.current = store.layout().terminalState;
        }
        onDragging(dragging);
      }}
      className={`wb-splitter-${splitter}`}
    />
  );
}
