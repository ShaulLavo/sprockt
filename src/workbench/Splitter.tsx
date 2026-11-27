// Resize handle between panes backed by `@shaulavo/workbench`'s WAI-ARIA `Splitter`.
import { useEffect, useRef } from "react";
import {
  DRAG_THRESHOLD_PX,
  dragPaneGeometry,
  type GlobalPaneGeometry,
  type Space,
} from "@shaulavo/workbench/core";
import { Splitter as WorkbenchSplitter } from "@shaulavo/workbench";
import { useValue } from "../lib/react";
import type { LayoutStore } from "./layout-store";
import {
  handleKeyOf,
  isOpen,
  MIN_PX,
  setOpen,
  type PaneLayout,
  type Splitter as SplitterName,
  type TerminalState,
} from "./layout";

const KEYBOARD_STEP_PX = 24;
const KEYBOARD_BIG_STEP_PX = 96;

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

interface TerminalDragContext {
  readonly pointerId: number;
  readonly startState: TerminalState;
  readonly startY: number;
  latestY: number;
}

function nextTerminalState(
  geometry: GlobalPaneGeometry,
  previous: PaneLayout,
  splitter: SplitterName,
  drag: TerminalDragContext | undefined,
): TerminalState {
  if (splitter !== "terminal") return previous.terminalState;
  if (geometry.terminalOpen) return "open";
  if (drag?.startState === "collapsed" && drag.latestY - drag.startY < DRAG_THRESHOLD_PX) {
    return "collapsed";
  }
  return "hidden";
}

function fromGeometry(
  geometry: GlobalPaneGeometry,
  previous: PaneLayout,
  splitter: SplitterName,
  drag: TerminalDragContext | undefined,
): PaneLayout {
  return {
    explorer: geometry.explorerWidthPx,
    preview: geometry.previewFraction,
    terminal: geometry.terminalHeightPx,
    explorerOpen: geometry.explorerOpen,
    previewOpen: geometry.previewOpen,
    terminalState: nextTerminalState(geometry, previous, splitter, drag),
  };
}

function isExpanded(layout: PaneLayout, splitter: SplitterName): boolean {
  if (splitter === "terminal") return layout.terminalState === "open";
  return isOpen(layout, splitter);
}

export function Splitter(props: SplitterProps) {
  const layout = useValue(props.store.layout);
  const { splitter, store, measureSpace, onDragging } = props;
  const draggingRef = useRef(false);
  const terminalDragRef = useRef<TerminalDragContext | undefined>(undefined);

  // Track the initiating pointer's drag on the terminal handle so a round-trip drag that starts
  // from `collapsed` (or drags upward without reaching the open threshold) restores `collapsed`
  // instead of hiding, unaffected by secondary pointers.
  useEffect(() => {
    if (splitter !== "terminal") return;
    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0 || terminalDragRef.current || !(event.target instanceof Element)) return;
      if (event.target.closest('[data-wb-splitter="terminal"]') === null) return;
      terminalDragRef.current = {
        pointerId: event.pointerId,
        startState: store.layout().terminalState,
        startY: event.clientY,
        latestY: event.clientY,
      };
    };
    const onPointerMove = (event: PointerEvent): void => {
      const drag = terminalDragRef.current;
      if (!draggingRef.current || !drag || event.pointerId !== drag.pointerId) return;
      drag.latestY = event.clientY;
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointermove", onPointerMove, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointermove", onPointerMove, true);
    };
  }, [splitter, store]);

  // Handle `Home` consistently as "minimum open size" using Workbench's own `dragPaneGeometry`
  // bounds so subsequent arrow steps never disagree with Home, and intercept grow/shrink on
  // collapsed or hidden panes so keyboard expansion always opens cleanly.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.target instanceof Element)) return;
      if (event.target.getAttribute("data-wb-splitter") !== splitter) return;
      const action = handleKeyOf(splitter, event.key);
      if (action === "min") {
        event.preventDefault();
        event.stopPropagation();
        const current = store.layout();
        const minPx = MIN_PX[splitter];
        const next = dragPaneGeometry(splitter, {
          startGeometry: toGeometry(current),
          startPx: minPx + DRAG_THRESHOLD_PX,
          growth: -DRAG_THRESHOLD_PX,
          space: measureSpace(),
        });
        store.set(fromGeometry(next, current, splitter, undefined));
        return;
      }
      const current = store.layout();
      if (isExpanded(current, splitter)) return;
      if (action === "grow") {
        event.preventDefault();
        event.stopPropagation();
        const step = event.shiftKey ? KEYBOARD_BIG_STEP_PX : KEYBOARD_STEP_PX;
        const next = dragPaneGeometry(splitter, {
          startGeometry: toGeometry(current),
          startPx: MIN_PX[splitter],
          growth: step,
          space: measureSpace(),
        });
        store.set(fromGeometry(next, current, splitter, undefined));
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
      onPreviewGeometry={(next) =>
        store.show(fromGeometry(next, store.layout(), splitter, terminalDragRef.current))
      }
      onCommitGeometry={(next) => {
        const drag = terminalDragRef.current;
        terminalDragRef.current = undefined;
        store.set(fromGeometry(next, store.layout(), splitter, drag));
      }}
      onDraggingChange={(dragging) => {
        draggingRef.current = dragging;
        if (!dragging) {
          queueMicrotask(() => {
            if (!draggingRef.current) terminalDragRef.current = undefined;
          });
        }
        onDragging(dragging);
      }}
      className={`wb-splitter-${splitter}`}
    />
  );
}
