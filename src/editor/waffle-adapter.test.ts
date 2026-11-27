import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { batch, createRoot, createSignal } from "../lib/reactive";
import type { FileChange } from "../files/service";
import { createEditorStore } from "./store";
import {
  buildSprocktEditorTabs,
  createSprocktEditorDocumentAdapter,
  createSprocktEditorGroupAdapter,
  SPROCKT_EDITOR_GROUP_ID,
} from "./waffle-adapter";

function createMemoryStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key: string) => entries.get(key) ?? null,
    key: (index: number) => Array.from(entries.keys())[index] ?? null,
    removeItem: (key: string) => {
      entries.delete(key);
    },
    setItem: (key: string, value: string) => {
      entries.set(key, String(value));
    },
  };
}

const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: createMemoryStorage(),
  });
});

afterEach(() => {
  if (originalLocalStorageDescriptor) {
    Object.defineProperty(globalThis, "localStorage", originalLocalStorageDescriptor);
    return;
  }
  delete (globalThis as { localStorage?: Storage }).localStorage;
});

function createMemoryFiles(initial: Readonly<Record<string, string>>) {
  const data = new Map<string, string>(Object.entries(initial));
  const [revision, setRevision] = createSignal(0);
  const [writable] = createSignal(true);
  const listeners = new Set<(change: FileChange) => void>();
  return {
    data,
    read: async (path: string) => data.get(path),
    writeIfUnchanged: async (path: string, text: string, expected: string | undefined) => {
      const current = data.get(path);
      if (current !== expected) return { written: false as const, current };
      data.set(path, text);
      setRevision((value) => value + 1);
      return { written: true as const };
    },
    saved: async () => {},
    revision,
    writable,
    subscribe(listener: (change: FileChange) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

describe("Sprockt workbench editor adapters", () => {
  it("projects open tabs, duplicate hints, tones, and group operations through EditorGroupAdapter", () => {
    const files = createMemoryFiles({
      "src/a/index.ts": "export const a = 1;\n",
      "src/b/index.ts": "export const b = 2;\n",
      "styles.css": "body {}\n",
    });

    let cleanup: (() => void) | undefined;
    const store = createRoot((dispose) => {
      cleanup = dispose;
      return createEditorStore({ id: `test-group-${crypto.randomUUID()}`, files });
    });

    try {
      const groupAdapter = createSprocktEditorGroupAdapter(store);

      let notifications = 0;
      let secondNotifications = 0;
      const unsub = groupAdapter.groups.subscribe(() => {
        notifications += 1;
      });
      const unsubSecond = groupAdapter.groups.subscribe(() => {
        secondNotifications += 1;
      });

      batch(() => {
        groupAdapter.openDocument("src/a/index.ts", {
          focus: { shouldFocusEditor: true, origin: "mouse" },
        });
        // Reading getSnapshot() inside a batch before effects flush must not suppress notifications.
        expect(groupAdapter.groups.getSnapshot().root.kind).toBe("group");
      });
      expect(notifications).toBe(1);
      expect(secondNotifications).toBe(1);

      groupAdapter.openDocument("src/b/index.ts", {
        preview: true,
        focus: { shouldFocusEditor: false, origin: "touch" },
      });
      groupAdapter.openDocument("styles.css", {
        focus: { shouldFocusEditor: true, origin: "keyboard" },
      });

      expect(notifications).toBeGreaterThanOrEqual(3);
      expect(secondNotifications).toBe(notifications);

      // Snapshot contract: unchanged reads must return the same reference for useSyncExternalStore.
      const snap1 = groupAdapter.groups.getSnapshot();
      const snap2 = groupAdapter.groups.getSnapshot();
      expect(snap1).toBe(snap2);

      const descriptors = buildSprocktEditorTabs(store);
      expect(descriptors.map((tab) => ({ id: tab.id, hint: tab.hint, tone: tab.tone }))).toEqual([
        { id: "src/a/index.ts", hint: "src/a", tone: "ts" },
        { id: "src/b/index.ts", hint: "src/b", tone: "ts" },
        { id: "styles.css", hint: undefined, tone: "css" },
      ]);

      // Touch selection sets focus: false (no reveal focus request).
      groupAdapter.selectTab(SPROCKT_EDITOR_GROUP_ID, "src/b/index.ts", {
        shouldFocusEditor: false,
        origin: "touch",
      });
      expect(store.active()).toBe("src/b/index.ts");
      expect(store.reveal()?.path).not.toBe("src/b/index.ts");

      // Pinning clears preview flag.
      groupAdapter.pinTab(SPROCKT_EDITOR_GROUP_ID, "src/b/index.ts");
      expect(store.tabs().find((tab) => tab.path === "src/b/index.ts")?.preview).toBe(false);

      // Strip placement reorders tabs.
      groupAdapter.placeTab({
        tabId: "styles.css",
        mode: "move",
        target: { kind: "strip", groupId: SPROCKT_EDITOR_GROUP_ID, beforeTabId: "src/a/index.ts" },
      });
      expect(store.tabs().map((tab) => tab.path)).toEqual(["styles.css", "src/a/index.ts", "src/b/index.ts"]);

      // Closing removes clean tab.
      groupAdapter.closeTabs(SPROCKT_EDITOR_GROUP_ID, ["styles.css"]);
      expect(store.tabs().map((tab) => tab.path)).toEqual(["src/a/index.ts", "src/b/index.ts"]);
      unsub();
      unsubSecond();
    } finally {
      cleanup?.();
    }
  });

  it("loads documents, writes conditionally, and resolves conflicts via EditorDocumentAdapter", async () => {
    const files = createMemoryFiles({ "note.txt": "hello\n" });

    let cleanup: (() => void) | undefined;
    const store = createRoot((dispose) => {
      cleanup = dispose;
      return createEditorStore({ id: `test-doc-${crypto.randomUUID()}`, files });
    });

    try {
      const adapter = createSprocktEditorDocumentAdapter(store, files);
      const loaded = await adapter.loadDocument("note.txt");
      expect(loaded).toEqual({ text: "hello\n", revision: "hello\n", byteLength: 6 });

      const written = await adapter.writeIfUnchanged("note.txt", "updated\n", "hello\n");
      expect(written).toEqual({ written: true, nextRevision: "updated\n" });

      const conflictOutcome = await adapter.writeIfUnchanged("note.txt", "stale\n", "hello\n");
      expect(conflictOutcome).toEqual({
        written: false,
        currentText: "updated\n",
        currentRevision: "updated\n",
      });
    } finally {
      cleanup?.();
    }
  });
});
