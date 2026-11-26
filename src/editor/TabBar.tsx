// The open-file tabs. Mouse and pen drags reorder them (a touch drag scrolls the strip instead),
// a middle click closes one, a double click pins a preview, and the strip fades at an edge only
// when tabs are actually hidden past it.
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
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

/** Live reordering: the dragged tab takes the slot under the pointer as it moves. */
function createTabDrag(strip: () => HTMLElement, store: EditorStore) {
  const [dragging, setDragging] = createSignal<number>();
  let state: DragState | undefined;
  let suppressClick = false;

  function slotAt(clientX: number, from: number): number {
    const tabs = Array.from(strip().querySelectorAll<HTMLElement>("[role=tab]"));
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

  function end(event: PointerEvent): void {
    if (!state || event.pointerId !== state.pointerId) return;
    suppressClick = state.moved;
    state = undefined;
    setDragging(undefined);
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
  }

  onCleanup(() => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
  });

  return {
    dragging,
    start(event: PointerEvent, index: number): void {
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
  };
}

/** Which edges have tabs hidden past them, kept current through scrolling, resizing and changes. */
function createOverflow(strip: () => HTMLElement, tabs: () => readonly EditorTab[]) {
  const [edges, setEdges] = createSignal({ start: false, end: false });
  const measure = () => {
    const element = strip();
    const end = element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
    setEdges({ start: element.scrollLeft > 1, end });
  };
  onMount(() => {
    const observer = new ResizeObserver(measure);
    observer.observe(strip());
    onCleanup(() => observer.disconnect());
  });
  createEffect(on(tabs, () => queueMicrotask(measure)));
  return { edges, measure };
}

function Tab(props: {
  tab: EditorTab;
  index: number;
  store: EditorStore;
  label: string;
  hint: string | undefined;
  dragging: boolean;
  onPointerDown: (event: PointerEvent) => void;
  onActivate: () => void;
}) {
  const active = () => props.store.active() === props.tab.path;
  const dirty = () => props.store.hasUnsaved(props.tab.path);
  const missing = () => props.store.buffers.get(props.tab.path)?.missing() ?? false;
  let element!: HTMLDivElement;

  createEffect(() => {
    if (active()) element.scrollIntoView({ block: "nearest", inline: "nearest" });
  });

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      props.onActivate();
    } else if (event.key === "Delete") {
      requestClose(props.store, props.tab.path);
    }
  }

  return (
    <div
      ref={(node) => (element = node)}
      role="tab"
      class="editor-tab"
      classList={{
        "is-active": active(),
        "is-dirty": dirty(),
        "is-preview": props.tab.preview,
        "is-missing": missing(),
        "is-dragging": props.dragging,
      }}
      tabindex={active() ? 0 : -1}
      aria-selected={active()}
      title={missing() ? `${originalPath(props.tab.path)} · ${EDITOR_COPY.deletedFile}` : props.tab.path}
      data-testid="editor-tab"
      data-path={props.tab.path}
      data-tab-tone={fileTabTone(props.tab.path)}
      onPointerDown={(event) => props.onPointerDown(event)}
      onClick={() => props.onActivate()}
      onDblClick={() => props.store.pin(props.tab.path)}
      onMouseDown={(event) => event.button === 1 && event.preventDefault()}
      onAuxClick={(event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        requestClose(props.store, props.tab.path);
      }}
      onKeyDown={onKeyDown}
    >
      <FileIcon path={props.tab.path} />
      <span class="editor-tab-name">{props.label}</span>
      {props.hint && <span class="editor-tab-hint">{props.hint}</span>}
      <span class="editor-tab-end">
        <Show when={dirty()}>
          <span
            class="editor-tab-dirty"
            role="img"
            aria-label={EDITOR_COPY.unsavedChanges}
            data-testid={props.store.displayed() === props.tab.path ? "editor-dirty" : undefined}
          />
        </Show>
        <button
          type="button"
          class="editor-tab-close"
          tabindex="-1"
          aria-label={fill(EDITOR_COPY.closeTab, { name: props.label })}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            requestClose(props.store, props.tab.path);
          }}
        >
          <CloseIcon />
        </button>
      </span>
    </div>
  );
}

export function TabBar(props: { store: EditorStore }) {
  let strip!: HTMLDivElement;
  const drag = createTabDrag(() => strip, props.store);
  const overflow = createOverflow(() => strip, props.store.tabs);

  // Tabs with the same file name show their directory so they can be told apart.
  const shared = createMemo(() => {
    const counts = new Map<string, number>();
    for (const tab of props.store.tabs())
      counts.set(basename(tab.path), (counts.get(basename(tab.path)) ?? 0) + 1);
    return counts;
  });

  function activate(tab: EditorTab): void {
    if (drag.takeSuppressedClick()) return;
    props.store.open(tab.path, { preview: tab.preview, focus: true });
  }

  return (
    <div
      class="editor-tabs"
      classList={{ "fade-start": overflow.edges().start, "fade-end": overflow.edges().end }}
      data-testid="editor-tabs"
    >
      <div
        ref={(node) => (strip = node)}
        class="editor-tabs-strip"
        role="tablist"
        aria-label={EDITOR_COPY.openFiles}
        onScroll={overflow.measure}
      >
        <For each={props.store.tabs()}>
          {(tab, index) => (
            <Tab
              tab={tab}
              index={index()}
              store={props.store}
              label={basename(tab.path)}
              hint={(shared().get(basename(tab.path)) ?? 0) > 1 ? dirname(tab.path) || "/" : undefined}
              dragging={drag.dragging() === index()}
              onPointerDown={(event) => drag.start(event, index())}
              onActivate={() => activate(tab)}
            />
          )}
        </For>
      </div>
    </div>
  );
}
