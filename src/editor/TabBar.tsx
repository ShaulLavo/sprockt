// The open-file tabs. Mouse and pen drags reorder them (a touch drag scrolls the strip instead),
// a middle click closes one, a double click pins a preview, and the strip fades at an edge only
// when tabs are actually hidden past it.
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { useValue } from "../lib/react";
import { CloseIcon, FileIcon } from "../search/icons";
import { fileTabTone } from "../ui/tab-colors";
import { originalPath } from "./buffers";
import { EDITOR_COPY, fill } from "./copy";
import type { EditorStore } from "./store";
import type { EditorTab } from "./tabs";

const DRAG_THRESHOLD_PX = 5;

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const dirname = (path: string) => {
  const shown = originalPath(path);
  return shown.slice(0, Math.max(shown.lastIndexOf("/"), 0));
};

/** Joins a base class with the flags that are on. */
function classes(base: string, flags: Readonly<Record<string, boolean>>): string {
  return [base].concat(Object.keys(flags).filter((name) => flags[name])).join(" ");
}

/** Asks before closing a tab with unsaved edits. */
export function requestClose(store: EditorStore, path: string): void {
  if (store.hasUnsaved(path) && !confirm(fill(EDITOR_COPY.discardChanges, { name: basename(path) }))) return;
  store.close(path);
}

interface DragState {
  index: number;
  readonly startX: number;
  readonly pointerId: number;
  moved: boolean;
}

type DragStart = Pick<PointerEvent, "button" | "pointerType" | "clientX" | "pointerId">;

/** Live reordering: the dragged tab takes the slot under the pointer as it moves. */
function createTabDrag(
  strip: RefObject<HTMLDivElement | null>,
  store: EditorStore,
  setDragging: (slot: number | undefined) => void,
) {
  let state: DragState | undefined;
  let suppressClick = false;

  function slotAt(clientX: number, from: number): number {
    const tabs = Array.from(strip.current?.querySelectorAll<HTMLElement>("[role=tab]") ?? []);
    const before = tabs.filter((tab, index) => {
      if (index === from) return false;
      const rect = tab.getBoundingClientRect();
      return rect.left + rect.width / 2 < clientX;
    });
    return before.length;
  }

  function move(event: PointerEvent): void {
    if (!state || event.pointerId !== state.pointerId) return;
    if (!state.moved && Math.abs(event.clientX - state.startX) < DRAG_THRESHOLD_PX) return;
    state.moved = true;
    const slot = slotAt(event.clientX, state.index);
    setDragging(slot);
    if (slot === state.index) return;
    store.move(state.index, slot);
    state.index = slot;
  }

  function stopListening(): void {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
  }

  function end(event: PointerEvent): void {
    if (!state || event.pointerId !== state.pointerId) return;
    suppressClick = state.moved;
    state = undefined;
    setDragging(undefined);
    stopListening();
  }

  return {
    start(event: DragStart, index: number): void {
      if (event.button !== 0 || event.pointerType === "touch") return;
      state = { index, startX: event.clientX, pointerId: event.pointerId, moved: false };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
    },
    /** True once for the click that ends a drag, which must not also activate the tab. */
    takeSuppressedClick(): boolean {
      const suppressed = suppressClick;
      suppressClick = false;
      return suppressed;
    },
    dispose: stopListening,
  };
}

/** Which edges have tabs hidden past them, kept current through scrolling, resizing and changes. */
function useOverflow(strip: RefObject<HTMLDivElement | null>, tabs: readonly EditorTab[]) {
  const [edges, setEdges] = useState({ start: false, end: false });
  const [measure] = useState(() => () => {
    const element = strip.current;
    if (!element) return;
    const start = element.scrollLeft > 1;
    const end = element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
    setEdges((current) => (current.start === start && current.end === end ? current : { start, end }));
  });
  useEffect(() => {
    const element = strip.current;
    if (!element) return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [strip, measure]);
  useEffect(() => queueMicrotask(measure), [tabs, measure]);
  return { edges, measure };
}

function Tab(props: {
  tab: EditorTab;
  index: number;
  store: EditorStore;
  label: string;
  hint: string | undefined;
  dragging: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onActivate: () => void;
}) {
  const { tab, store } = props;
  const active = useValue(() => store.active() === tab.path);
  const dirty = useValue(() => store.hasUnsaved(tab.path));
  const missing = useValue(() => store.buffers.get(tab.path)?.missing() ?? false);
  const displayed = useValue(() => store.displayed() === tab.path);
  const element = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (active) element.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      props.onActivate();
    } else if (event.key === "Delete") {
      requestClose(store, tab.path);
    }
  }

  const className = classes("editor-tab", {
    "is-active": active,
    "is-dirty": dirty,
    "is-preview": tab.preview,
    "is-missing": missing,
    "is-dragging": props.dragging,
  });

  return (
    <div
      ref={element}
      role="tab"
      className={className}
      tabIndex={active ? 0 : -1}
      aria-selected={active}
      title={missing ? `${originalPath(tab.path)} · ${EDITOR_COPY.deletedFile}` : tab.path}
      data-testid="editor-tab"
      data-path={tab.path}
      data-tab-tone={fileTabTone(tab.path)}
      onPointerDown={(event) => props.onPointerDown(event)}
      onClick={() => props.onActivate()}
      onDoubleClick={() => store.pin(tab.path)}
      onMouseDown={(event) => event.button === 1 && event.preventDefault()}
      onAuxClick={(event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        requestClose(store, tab.path);
      }}
      onKeyDown={onKeyDown}
    >
      <FileIcon path={tab.path} />
      <span className="editor-tab-name">{props.label}</span>
      {props.hint && <span className="editor-tab-hint">{props.hint}</span>}
      <span className="editor-tab-end">
        {dirty ? (
          <span
            className="editor-tab-dirty"
            role="img"
            aria-label={EDITOR_COPY.unsavedChanges}
            data-testid={displayed ? "editor-dirty" : undefined}
          />
        ) : null}
        <button
          type="button"
          className="editor-tab-close"
          tabIndex={-1}
          aria-label={fill(EDITOR_COPY.closeTab, { name: props.label })}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            requestClose(store, tab.path);
          }}
        >
          <CloseIcon />
        </button>
      </span>
    </div>
  );
}

export function TabBar(props: { store: EditorStore }) {
  const { store } = props;
  const strip = useRef<HTMLDivElement>(null);
  const tabs = useValue(store.tabs);
  const [dragging, setDragging] = useState<number>();
  const [drag] = useState(() => createTabDrag(strip, store, setDragging));
  useEffect(() => drag.dispose, [drag]);
  const overflow = useOverflow(strip, tabs);

  // Tabs with the same file name show their directory so they can be told apart.
  const shared = new Map<string, number>();
  for (const tab of tabs) shared.set(basename(tab.path), (shared.get(basename(tab.path)) ?? 0) + 1);

  function activate(tab: EditorTab): void {
    if (drag.takeSuppressedClick()) return;
    store.open(tab.path, { preview: tab.preview, focus: true });
  }

  return (
    <div
      className={classes("editor-tabs", {
        "fade-start": overflow.edges.start,
        "fade-end": overflow.edges.end,
      })}
      data-testid="editor-tabs"
    >
      <div
        ref={strip}
        className="editor-tabs-strip"
        role="tablist"
        aria-label={EDITOR_COPY.openFiles}
        onScroll={overflow.measure}
      >
        {tabs.map((tab, index) => (
          <Tab
            key={tab.path}
            tab={tab}
            index={index}
            store={store}
            label={basename(tab.path)}
            hint={(shared.get(basename(tab.path)) ?? 0) > 1 ? dirname(tab.path) || "/" : undefined}
            dragging={dragging === index}
            onPointerDown={(event) => drag.start(event, index)}
            onActivate={() => activate(tab)}
          />
        ))}
      </div>
    </div>
  );
}
