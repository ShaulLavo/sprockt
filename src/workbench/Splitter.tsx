// Resize handle between panes backed by `@shaulavo/workbench`'s WAI-ARIA `Splitter`.
import { useEffect, useRef } from "react";
import { DRAG_THRESHOLD_PX, type GlobalPaneGeometry, type Space } from "@shaulavo/workbench/core";
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

interface TerminalDragContext {
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
  const { splitter, store, measureSpace, onDragging } = props;
  const draggingRef = useRef(false);
  const terminalDragRef = useRef<TerminalDragContext | undefined>(undefined);

  // Track pointer drags on the terminal handle so a round-trip drag that starts from `collapsed`
  // (or drags upward without reaching the open threshold) restores `collapsed` instead of hiding.
  useEffect(() => {
    if (splitter !== "terminal") return;
    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0 || !(event.target instanceof Element)) return;
      if (event.target.closest('[data-wb-splitter="terminal"]') === null) return;
      terminalDragRef.current = {
        startState: store.layout().terminalState,
        startY: event.clientY,
        latestY: event.clientY,
      };
    };
    const onPointerMove = (event: PointerEvent): void => {
      if (!draggingRef.current || !terminalDragRef.current) return;
      terminalDragRef.current.latestY = event.clientY;
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointermove", onPointerMove, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointermove", onPointerMove, true);
    };
  }, [splitter, store]);

  // Handle `Home` consistently as "minimum open size" on every splitter (avoiding WorkbenchSplitter's
  // close-on-Home behavior), and intercept grow/shrink on collapsed or hidden panes so keyboard
  // expansion always opens cleanly instead of falling below the drag threshold.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.target instanceof Element)) return;
      if (event.target.getAttribute("data-wb-splitter") !== splitter) return;
      const action = handleKeyOf(splitter, event.key);
      if (action === "min") {
        event.preventDefault();
        event.stopPropagation();
        const current = store.layout();
        const room = splitterRoom(splitter, current, measureSpace());
        store.set(keyTo(current, splitter, "min", room, event.shiftKey));
        return;
      }
      const current = store.layout();
      if (isExpanded(current, splitter)) return;
      if (action === "grow") {
        event.preventDefault();
        event.stopPropagation();
        const room = splitterRoom(splitter, current, measureSpace());
        store.set(keyTo(current, splitter, "grow", room, event.shiftKey));
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
