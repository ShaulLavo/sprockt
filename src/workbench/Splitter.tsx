// A resize handle between two panes: drag it, or focus it and use the arrow keys (Shift for big
// steps), Home and End, and Enter to close or reopen the pane. Double-click also toggles.
// While dragging, sizes are measured once at the start and written at most once per frame.
import { createSignal } from "solid-js";
import type { LayoutStore } from "./layout-store";
import {
  DRAG_THRESHOLD_PX,
  dragLayout,
  handleKeyOf,
  isOpen,
  keyTo,
  setOpen,
  type PaneLayout,
  type Room,
  type Splitter as SplitterName,
} from "./layout";

export interface SplitterProps {
  readonly splitter: SplitterName;
  readonly label: string;
  /** The id of the pane this handle resizes. */
  readonly controls: string;
  readonly store: LayoutStore;
  /** Measures the room the pane shares, once per drag or key press. */
  measure(): Room;
  /** The pane's size on screen in CSS pixels, read once when a drag starts. */
  measureSize(): number;
  /** The pane's share as rendered, 0 to 100, for assistive technology. */
  readonly valueNow: number;
  onDragging(dragging: boolean): void;
}

/** +1 when moving the pointer right (or down) grows the pane, -1 when it shrinks it. */
const GROWTH: Readonly<Record<SplitterName, 1 | -1>> = { explorer: 1, preview: -1, terminal: -1 };

interface Gesture {
  readonly pointer: number;
  /** The pointer coordinate at the press. */
  readonly start: number;
  latest: number;
  /** Set once the pointer first leaves the click threshold: from then on it is a drag. */
  dragged: boolean;
  readonly startLayout: PaneLayout;
  readonly startPx: number;
  readonly room: Room;
}

export function Splitter(props: SplitterProps) {
  const [dragging, setDragging] = createSignal(false);
  const vertical = props.splitter !== "terminal";
  let drag: Gesture | undefined;
  let frame = 0;

  const coordinate = (event: PointerEvent) => (vertical ? event.clientX : event.clientY);

  function paint(): void {
    frame = 0;
    if (!drag) return;
    const growth = GROWTH[props.splitter] * (drag.latest - drag.start);
    if (!drag.dragged && Math.abs(growth) < DRAG_THRESHOLD_PX) return;
    drag.dragged = true;
    props.store.show(dragLayout(props.splitter, { ...drag, growth }));
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || drag) return;
    event.preventDefault();
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    const start = coordinate(event);
    const startLayout = props.store.layout();
    // The size on screen, which a narrow window may hold below the saved one.
    const startPx = isOpen(startLayout, props.splitter) ? props.measureSize() : 0;
    drag = {
      pointer: event.pointerId,
      start,
      latest: start,
      dragged: false,
      startLayout,
      startPx,
      room: props.measure(),
    };
    setDragging(true);
    props.onDragging(true);
  }

  function onPointerMove(event: PointerEvent): void {
    if (!drag || event.pointerId !== drag.pointer) return;
    drag.latest = coordinate(event);
    frame ||= requestAnimationFrame(paint);
  }

  /** A click changes nothing; a drag saves where it ended, its starting layout if it came back. */
  function end(): void {
    if (!drag) return;
    cancelAnimationFrame(frame);
    paint();
    const dragged = drag.dragged;
    drag = undefined;
    if (dragged) props.store.commit();
    setDragging(false);
    props.onDragging(false);
  }

  function onKeyDown(event: KeyboardEvent): void {
    const key = handleKeyOf(props.splitter, event.key);
    if (!key) return;
    event.preventDefault();
    const layout = props.store.layout();
    const shown = isOpen(layout, props.splitter) ? props.measureSize() : undefined;
    props.store.set(keyTo(layout, props.splitter, key, props.measure(), event.shiftKey, shown));
  }

  function toggle(): void {
    const layout = props.store.layout();
    props.store.set(setOpen(layout, props.splitter, !isOpen(layout, props.splitter)));
  }

  return (
    <div
      class={`wb-splitter wb-splitter-${props.splitter}`}
      classList={{ "is-dragging": dragging(), "is-closed": !isOpen(props.store.layout(), props.splitter) }}
      role="separator"
      tabindex="0"
      aria-label={props.label}
      aria-controls={props.controls}
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow={props.valueNow}
      data-testid={`splitter-${props.splitter}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onKeyDown={onKeyDown}
      onDblClick={toggle}
    />
  );
}
