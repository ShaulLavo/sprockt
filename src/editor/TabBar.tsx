// The open-file tabs rendered over @shaulavo/workbench-editor's EditorTabBar with Sprockt's
// Sheet & Biro styling, file icons, context menu, and unsaved-close confirmation flow.
import { EditorTabBar } from "@shaulavo/workbench-editor";
import { useRef, useState } from "react";
import { ContextMenu, type MenuItem } from "../explorer/ContextMenu";
import { useValue } from "../lib/react";
import { FileIcon } from "../search/icons";
import { originalPath } from "./buffers";
import { EDITOR_COPY } from "./copy";
import type { EditorStore } from "./store";
import { tabsToClose, type TabCloseScope } from "./tabs";
import { buildSprocktEditorTabs, SPROCKT_EDITOR_GROUP_ID } from "./waffle-adapter";

/** Asks before closing a tab with unsaved edits using the Sheet & Biro dialog. */
export function requestClose(store: EditorStore, path: string): void {
  store.requestClose([path]);
}

function buildTabMenuItems(
  store: EditorStore,
  path: string,
  closeScope: (scope: TabCloseScope, target: string) => void,
): MenuItem[] {
  const list = store.tabs();
  const index = list.findIndex((candidate) => candidate.path === path);
  const items: MenuItem[] = [
    {
      label: EDITOR_COPY.tabMenu.close,
      testId: "tab-menu-close",
      run: () => closeScope("self", path),
    },
  ];
  if (list.length > 1) {
    items.push({
      label: EDITOR_COPY.tabMenu.closeOthers,
      testId: "tab-menu-close-others",
      run: () => closeScope("others", path),
    });
  }
  if (index >= 0 && index < list.length - 1) {
    items.push({
      label: EDITOR_COPY.tabMenu.closeRight,
      testId: "tab-menu-close-right",
      run: () => closeScope("right", path),
    });
  }
  if (list.some((candidate) => !store.hasUnsaved(candidate.path))) {
    items.push({
      label: EDITOR_COPY.tabMenu.closeSaved,
      testId: "tab-menu-close-saved",
      run: () => closeScope("saved", path),
    });
  }
  items.push(
    {
      label: EDITOR_COPY.tabMenu.closeAll,
      testId: "tab-menu-close-all",
      run: () => closeScope("all", path),
    },
    {
      label: EDITOR_COPY.tabMenu.copyPath,
      testId: "tab-menu-copy-path",
      run: () => void navigator.clipboard?.writeText(originalPath(path)).catch(() => {}),
    },
  );
  return items;
}

export function TabBar(props: { store: EditorStore }) {
  const { store } = props;
  const strip = useRef<HTMLDivElement | null>(null);
  const tabs = useValue(() => buildSprocktEditorTabs(store));
  const active = useValue(store.active);
  const displayed = useValue(store.displayed);
  const [menu, setMenu] = useState<{ x: number; y: number; path: string }>();

  function closeScope(scope: TabCloseScope, path: string): void {
    const targets = tabsToClose(store.tabs(), scope, path, (candidate) => store.hasUnsaved(candidate));
    store.requestClose(targets);
  }

  return (
    <>
      <EditorTabBar
        groupId={SPROCKT_EDITOR_GROUP_ID}
        tabs={tabs}
        selectedTabId={active ?? null}
        label={EDITOR_COPY.openFiles}
        stripRef={strip}
        className="editor-tabs"
        testId="editor-tabs"
        renderIcon={(tab) => <FileIcon path={tab.path ?? tab.id} />}
        tabTestId={() => "editor-tab"}
        dirtyTestId={(tab) => (tab.id === displayed ? "editor-dirty" : undefined)}
        onSelectTab={(_gid, tabId, focus) => {
          const found = store.tabs().find((candidate) => candidate.path === tabId);
          store.open(tabId, { preview: found?.preview ?? false, focus: focus.shouldFocusEditor });
        }}
        onCloseTab={(_gid, tabId) => requestClose(store, tabId)}
        onPinTab={(_gid, tabId) => store.pin(tabId)}
        onReorderTab={(_gid, fromIndex, toIndex) => store.move(fromIndex, toIndex)}
        onTabContextMenu={(tab, event) => {
          event.preventDefault();
          event.stopPropagation();
          setMenu({ x: event.clientX, y: event.clientY, path: tab.id });
        }}
      />
      {menu ? (
        <ContextMenu
          key={`${menu.x}:${menu.y}:${menu.path}`}
          x={menu.x}
          y={menu.y}
          label={EDITOR_COPY.tabMenu.label}
          items={buildTabMenuItems(store, menu.path, closeScope)}
          onClose={(escaped) => {
            const path = menu.path;
            setMenu(undefined);
            if (!escaped) return;
            strip.current
              ?.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"] [role="tab"]`)
              ?.focus();
          }}
        />
      ) : null}
    </>
  );
}
