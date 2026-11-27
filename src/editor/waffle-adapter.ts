import type {
  ActivationFocusDecision,
  DocumentConflict,
  DocumentId,
  EditorDocumentAdapter,
  EditorGroupAdapter,
  EditorGroupsSnapshot,
  EditorTabDescriptor,
  GroupId,
  LoadedDocument,
  MoveLockHandle,
  OpenDocumentOptions,
  Subscribable,
  TabId,
  TabPlacement,
  WriteOutcome,
} from "@shaulavo/workbench-core";
import type { FileService } from "../files/service";
import { createEffect, createRoot } from "../lib/reactive";
import { fileTabTone } from "../ui/tab-colors";
import { originalPath } from "./buffers";
import { EDITOR_COPY } from "./copy";
import type { EditorStore } from "./store";

export const SPROCKT_EDITOR_GROUP_ID: GroupId = "main";

const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

const dirname = (path: string): string => {
  const shown = originalPath(path);
  return shown.slice(0, Math.max(shown.lastIndexOf("/"), 0));
};

const noop = (): void => {};

function createReactiveSubscribable<T>(read: () => T): Subscribable<T> {
  return {
    getSnapshot: read,
    subscribe(listener) {
      let initialized = false;
      let dispose = noop;
      createRoot((cleanup) => {
        dispose = cleanup;
        createEffect(() => {
          read();
          if (!initialized) {
            initialized = true;
            return;
          }
          listener();
        });
      });
      return dispose;
    },
  };
}

/** Projects Sprockt's open tabs and buffer dirty/missing flags into workbench tab descriptors. */
export function buildSprocktEditorTabs(store: EditorStore): readonly EditorTabDescriptor[] {
  const tabs = store.tabs();
  const shared = new Map<string, number>();
  for (const tab of tabs) {
    const name = basename(tab.path);
    shared.set(name, (shared.get(name) ?? 0) + 1);
  }
  return tabs.map((tab): EditorTabDescriptor => {
    const label = basename(tab.path);
    const missing = store.buffers.get(tab.path)?.missing() ?? false;
    const dirty = store.hasUnsaved(tab.path);
    const hint = (shared.get(label) ?? 0) > 1 ? dirname(tab.path) || "/" : undefined;
    const title = missing ? `${originalPath(tab.path)} · ${EDITOR_COPY.deletedFile}` : tab.path;
    return {
      id: tab.path,
      documentId: tab.path,
      kind: "file",
      path: tab.path,
      label,
      hint,
      title,
      tone: fileTabTone(tab.path),
      preview: tab.preview,
      dirty,
      missing,
    };
  });
}

function buildGroupSnapshot(store: EditorStore): EditorGroupsSnapshot {
  const tabs = buildSprocktEditorTabs(store);
  const selectedTabId = store.active() ?? null;
  return {
    activeGroupId: SPROCKT_EDITOR_GROUP_ID,
    root: {
      kind: "group",
      id: SPROCKT_EDITOR_GROUP_ID,
      tabs,
      selectedTabId,
    },
  };
}

/** Single-group `EditorGroupAdapter` backed by Sprockt's `EditorStore`. */
export function createSprocktEditorGroupAdapter(store: EditorStore): EditorGroupAdapter {
  let cached: EditorGroupsSnapshot = buildGroupSnapshot(store);
  const groups = createReactiveSubscribable<EditorGroupsSnapshot>(() => {
    cached = buildGroupSnapshot(store);
    return cached;
  });

  return {
    groups,
    selectTab(_groupId: GroupId, tabId: TabId, focus: ActivationFocusDecision) {
      const tab = store.tabs().find((candidate) => candidate.path === tabId);
      store.open(tabId, { preview: tab?.preview ?? false, focus: focus.shouldFocusEditor });
    },
    openDocument(documentId: DocumentId, options: OpenDocumentOptions) {
      store.open(documentId, {
        preview: options.preview,
        line: options.line,
        column: options.column,
        focus: options.focus.shouldFocusEditor,
      });
    },
    closeTabs(_groupId: GroupId, tabIds: readonly TabId[]) {
      store.requestClose(tabIds);
    },
    pinTab(_groupId: GroupId, tabId: TabId) {
      store.pin(tabId);
    },
    placeTab(placement: TabPlacement) {
      if (placement.target.kind !== "strip") return;
      const list = store.tabs();
      const from = list.findIndex((tab) => tab.path === placement.tabId);
      if (from < 0) return;
      const beforeId = placement.target.beforeTabId;
      if (beforeId === placement.tabId) return;
      const targetIndex = beforeId ? list.findIndex((tab) => tab.path === beforeId) : list.length;
      if (targetIndex < 0) return;
      const to = targetIndex > from ? targetIndex - 1 : targetIndex;
      if (to === from) return;
      store.move(from, to);
    },
  };
}

/** `EditorDocumentAdapter` bridging Sprockt's `EditorStore` and Waffle `FileService`. */
export function createSprocktEditorDocumentAdapter(
  store: EditorStore,
  files: Pick<FileService, "read" | "writeIfUnchanged">,
): EditorDocumentAdapter {
  const encoder = new TextEncoder();

  return {
    getConflict(documentId: DocumentId): Subscribable<DocumentConflict | undefined> {
      return createReactiveSubscribable(() => {
        const buffer = store.buffers.get(documentId);
        const conflict = buffer?.conflict();
        if (!conflict) return undefined;
        return {
          documentId,
          path: originalPath(documentId),
          diskText: conflict.diskText,
        };
      });
    },
    async loadDocument(documentId: DocumentId): Promise<LoadedDocument | undefined> {
      const text = await files.read(documentId);
      if (text === undefined) return undefined;
      return {
        text,
        revision: text,
        byteLength: encoder.encode(text).byteLength,
      };
    },
    async writeIfUnchanged(
      documentId: DocumentId,
      text: string,
      expectedRevision: string | undefined,
    ): Promise<WriteOutcome> {
      const outcome = await files.writeIfUnchanged(documentId, text, expectedRevision);
      if (outcome.written) return { written: true, nextRevision: text };
      return {
        written: false,
        currentText: outcome.current,
        currentRevision: outcome.current,
      };
    },
    save(documentId: DocumentId) {
      return store.save(documentId);
    },
    saveAll() {
      return store.saveAll();
    },
    async resolveConflict(documentId: DocumentId, choice: "keep-mine" | "take-theirs") {
      if (choice === "take-theirs") {
        await store.buffers.takeTheirs(documentId);
        return;
      }
      await store.buffers.keepMine(documentId);
      await store.save(documentId);
    },
    async lockPaths(roots: readonly string[]): Promise<MoveLockHandle> {
      return store.lockPaths(roots);
    },
  };
}
