// Adapts Sprockt's Waffle FileService + EditorStore to @shaulavo/workbench-core's lazy FileSystemAdapter.
import type {
  DirectoryLoadState,
  FileSystemAdapter,
  LazyInvalidationEvent,
  Subscribable,
} from "@shaulavo/workbench-core";
import {
  ancestorsOf,
  isSameOrInside,
  normalizeTreePath,
  parentOf,
  topLevelPaths,
} from "@shaulavo/workbench-tree";
import type { EditorStore } from "../editor/store";
import { rebase } from "../files/paths";
import type { DirEntry, FileService } from "../files/service";
import { createEffect, createRoot } from "../lib/reactive";

interface DirSlot {
  state: DirectoryLoadState;
  readonly listeners: Set<() => void>;
  readonly subscribable: Subscribable<DirectoryLoadState>;
  inFlight: Promise<void> | null;
}

export interface WaffleAdapterOptions {
  readonly workspaceId: string;
  readonly files: FileService;
  readonly store: EditorStore;
  readonly onDirectoryListed?: (dirPath: string, entries: readonly DirEntry[]) => void;
  readonly onPathsMoved?: (moves: readonly { readonly from: string; readonly to: string }[]) => void;
}

export interface WaffleFileSystemHandle {
  readonly adapter: FileSystemAdapter;
  /** Seeds a directory listing fetched outside the adapter (e.g., auto-opener). */
  seedDirectory(dirPath: string, entries: readonly DirEntry[]): void;
  /** Re-reads a directory from Waffle immediately. */
  refreshDirectory(dirPath: string): Promise<void>;
  /** Removes one or more paths cleanly, preserving unsaved tabs as missing. */
  removePaths(paths: readonly string[]): Promise<void>;
  /** Cleans up reactive subscriptions. */
  dispose(): void;
}

export function createWaffleFileSystemAdapter(options: WaffleAdapterOptions): WaffleFileSystemHandle {
  const { workspaceId, files, store, onDirectoryListed, onPathsMoved } = options;
  const slots = new Map<string, DirSlot>();
  const invalidationListeners = new Set<(event: LazyInvalidationEvent) => void>();
  const writableListeners = new Set<() => void>();
  let disposed = false;

  let currentWritable = files.writable();
  const stopWritable = createRoot((dispose) => {
    createEffect(() => {
      const next = files.writable();
      if (next === currentWritable) return;
      currentWritable = next;
      for (const listener of writableListeners) listener();
    });
    return dispose;
  });

  const writable: Subscribable<boolean> = {
    getSnapshot: () => currentWritable,
    subscribe(listener) {
      writableListeners.add(listener);
      return () => {
        writableListeners.delete(listener);
      };
    },
  };

  function ensureSlot(rawDir: string): DirSlot {
    const dir = normalizeTreePath(rawDir);
    const existing = slots.get(dir);
    if (existing) return existing;
    const listeners = new Set<() => void>();
    const slot: DirSlot = {
      state: { status: "idle" },
      listeners,
      inFlight: null,
      subscribable: {
        getSnapshot: () => slot.state,
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      },
    };
    slots.set(dir, slot);
    return slot;
  }

  function setSlotState(slot: DirSlot, next: DirectoryLoadState): void {
    slot.state = next;
    for (const listener of slot.listeners) listener();
  }

  function seedDirectory(rawDir: string, entries: readonly DirEntry[]): void {
    const dir = normalizeTreePath(rawDir);
    const slot = ensureSlot(dir);
    setSlotState(slot, { status: "loaded", entries });
  }

  async function loadDirectory(rawDir: string, loadOptions?: { readonly force?: boolean }): Promise<void> {
    if (disposed) return;
    const dir = normalizeTreePath(rawDir);
    const slot = ensureSlot(dir);
    if (!loadOptions?.force && slot.state.status === "loaded") return;
    if (slot.inFlight && !loadOptions?.force) return slot.inFlight;

    if (slot.state.status === "idle" || slot.state.status === "error") {
      setSlotState(slot, { status: "loading" });
    }

    const request = (async () => {
      try {
        const raw = await files.readdir(dir);
        if (disposed) return;
        const list = raw ?? [];
        setSlotState(slot, { status: "loaded", entries: list });
        onDirectoryListed?.(dir, list);
      } catch (error) {
        if (disposed) return;
        setSlotState(slot, {
          status: "error",
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        });
      }
    })();

    slot.inFlight = request;
    try {
      await request;
    } finally {
      if (slot.inFlight === request) slot.inFlight = null;
    }
  }

  const unsubFiles = files.subscribe((change) => {
    if (disposed) return;
    if (change.reset) {
      const resetEvent: LazyInvalidationEvent = {
        reset: true,
        directories: [],
        moves: [],
        removed: [],
      };
      for (const listener of invalidationListeners) listener(resetEvent);
      return;
    }

    const directories = new Set<string>();
    const markPathAndAncestors = (rawPath: string) => {
      const normalized = normalizeTreePath(rawPath);
      if (!normalized) {
        directories.add("");
        return;
      }
      directories.add(parentOf(normalized));
      if (slots.has(normalized)) directories.add(normalized);
      for (const ancestor of ancestorsOf(normalized)) {
        if (slots.has(ancestor)) directories.add(ancestor);
      }
    };

    for (const p of change.paths) markPathAndAncestors(p);
    for (const p of change.removed) markPathAndAncestors(p);
    for (const m of change.moves) {
      markPathAndAncestors(m.from);
      markPathAndAncestors(m.to);
    }

    if (directories.size === 0 && change.moves.length === 0 && change.removed.length === 0) return;
    const event: LazyInvalidationEvent = {
      reset: false,
      directories: Array.from(directories),
      moves: change.moves,
      removed: change.removed,
    };
    for (const listener of invalidationListeners) listener(event);
  });

  async function moveOne(rawFrom: string, rawTo: string): Promise<void> {
    const from = normalizeTreePath(rawFrom);
    const to = normalizeTreePath(rawTo);
    const lock = await store.lockPaths([from]);
    let moved = false;
    try {
      await files.move(from, to);
      moved = true;
    } finally {
      lock.release(moved);
      if (moved) onPathsMoved?.([{ from, to }]);
    }
  }

  async function removePaths(rawPaths: readonly string[]): Promise<void> {
    const roots = topLevelPaths(rawPaths.map(normalizeTreePath).filter(Boolean));
    for (const target of roots) {
      for (const tab of store.tabs()) {
        if (!isSameOrInside(tab.path, target)) continue;
        if (!store.hasUnsaved(tab.path)) store.close(tab.path);
      }
      // oxlint-disable-next-line no-await-in-loop
      await files.remove(target);
    }
  }

  const adapter: FileSystemAdapter = {
    workspaceId,
    writable,
    listFiles: () => files.list(),
    readText: (path) => files.read(path),
    size: (path) => files.size(path),
    async createFile(rawPath, content) {
      const target = normalizeTreePath(rawPath);
      try {
        await files.create(target, content);
        store.open(target, { focus: true });
      } finally {
        await loadDirectory(parentOf(target), { force: true });
      }
    },
    async createDirectory(rawPath) {
      const target = normalizeTreePath(rawPath);
      try {
        await files.mkdir(target);
      } finally {
        await loadDirectory(parentOf(target), { force: true });
      }
    },
    move: moveOne,
    remove: (path) => removePaths([path]),
    upload: (dirPath, items) => files.upload(items, normalizeTreePath(dirPath)),
    lazy: {
      getDirectoryState: (dirPath) => ensureSlot(dirPath).subscribable,
      loadDirectory,
      subscribeInvalidation(listener) {
        invalidationListeners.add(listener);
        return () => {
          invalidationListeners.delete(listener);
        };
      },
    },
  };

  return {
    adapter,
    seedDirectory,
    refreshDirectory: (dirPath) => loadDirectory(dirPath, { force: true }),
    removePaths,
    dispose() {
      disposed = true;
      unsubFiles();
      stopWritable();
      invalidationListeners.clear();
      writableListeners.clear();
    },
  };
}

/** Rebases a set of expanded directory paths after one or more moves/renames. */
export function rebaseExpandedPaths(
  paths: readonly string[],
  moves: readonly { readonly from: string; readonly to: string }[],
): string[] {
  return paths.map((entry) => {
    let next = entry;
    for (const m of moves) {
      next = rebase(next, m.from, m.to);
    }
    return next;
  });
}
