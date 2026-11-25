// Lightweight IndexedDB/OPFS storage inspection and deletion for the landing page.
// Imports only Waffle's fs/ storage modules so waffle/runtime.ts stays unloaded on "/".
import { IndexedDBStorage } from "waffle/fs/indexeddb";
import type { PersistedIndex, PersistedNode } from "waffle/fs/storage";

const INDEXEDDB_FORMAT_PREFIX = "waffle-indexeddb-";
const decoder = new TextDecoder();

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB request failed")), {
      once: true,
    });
  });
}

/** Opens an existing IndexedDB database without creating a new one when absent. */
export function openExistingDatabase(name: string): Promise<IDBDatabase | undefined> {
  if (!globalThis.indexedDB) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(name);
    } catch (error) {
      reject(error);
      return;
    }
    let missing = false;
    request.addEventListener(
      "upgradeneeded",
      () => {
        missing = true;
        request.transaction?.abort();
      },
      { once: true },
    );
    request.addEventListener(
      "error",
      () => {
        if (missing) resolve(undefined);
        else reject(request.error ?? new Error("Failed to open IndexedDB database"));
      },
      { once: true },
    );
    request.addEventListener(
      "success",
      () => {
        const database = request.result;
        database.addEventListener("versionchange", () => database.close(), { once: true });
        resolve(database);
      },
      { once: true },
    );
  });
}

async function isWorkspaceDatabase(database: IDBDatabase): Promise<boolean> {
  if (!database.objectStoreNames.contains("metadata")) return false;
  const metadata = database.transaction("metadata", "readonly").objectStore("metadata");
  const [format, epoch, keys] = await Promise.all([
    idbRequest<unknown>(metadata.get("format")),
    idbRequest<unknown>(metadata.get("epoch")),
    idbRequest(metadata.getAllKeys()),
  ]);
  if (typeof format === "string" && format.startsWith(INDEXEDDB_FORMAT_PREFIX)) return true;
  if (database.version !== 1 || database.objectStoreNames.length !== 3) return false;
  if (!database.objectStoreNames.contains("journal") || !database.objectStoreNames.contains("data")) {
    return false;
  }
  const allowedKeys = new Set<IDBValidKey>([
    0,
    1,
    "epoch",
    "lastExclusiveEpoch",
    "active",
    "identity",
    "format",
  ]);
  return (
    typeof epoch === "number" &&
    Number.isSafeInteger(epoch) &&
    epoch > 0 &&
    keys.some((key) => key === 0 || key === 1) &&
    keys.every((key) => allowedKeys.has(key))
  );
}

function findNodeAtPath(index: PersistedIndex, absolutePath: string): PersistedNode | undefined {
  const byIno = new Map<number, PersistedNode>(index.nodes.map((node) => [node.ino, node]));
  const parts = absolutePath.split("/").filter(Boolean);
  let current = byIno.get(index.root);
  for (const part of parts) {
    if (!current || current.kind !== "dir" || !current.children) return undefined;
    const match = current.children.find(([name]) => name === part);
    if (!match) return undefined;
    current = byIno.get(match[1]);
  }
  return current;
}

async function withIdleIndexedDbLock<T>(name: string, task: () => Promise<T>): Promise<T | "busy"> {
  const locks = globalThis.navigator?.locks;
  if (!locks) return task();
  return locks.request(
    `bun-wasm:filesystem:indexeddb-maintenance:${name}`,
    { mode: "exclusive", ifAvailable: true },
    async (maintenance) => {
      if (!maintenance) return "busy" as const;
      return locks.request(
        `bun-wasm:filesystem:indexeddb-arb:${name}`,
        { mode: "shared", ifAvailable: true },
        async (arb) => {
          if (!arb) return "busy" as const;
          return locks.request(
            `bun-wasm:filesystem:indexeddb:${name}`,
            { mode: "exclusive", ifAvailable: true },
            async (writer) => {
              if (!writer) return "busy" as const;
              return task();
            },
          );
        },
      );
    },
  );
}

export type WorkspaceInspectionResult =
  | { readonly status: "busy" }
  | { readonly status: "missing" }
  | { readonly status: "idle"; readonly rawMeta: string | undefined };

export async function inspectIdleWorkspaceMeta(
  name: string,
  metaPath: string,
): Promise<WorkspaceInspectionResult> {
  const result = await withIdleIndexedDbLock(name, async (): Promise<WorkspaceInspectionResult> => {
    const database = await openExistingDatabase(name);
    if (!database) return { status: "missing" };
    let storage: IndexedDBStorage | undefined;
    try {
      if (!(await isWorkspaceDatabase(database))) return { status: "missing" };
      const connection = IndexedDBStorage.readOnlyConnection(database, () => Promise.resolve());
      storage = connection.storage;
      const index = await storage.load();
      if (!index) return { status: "idle", rawMeta: undefined };
      const metaNode = findNodeAtPath(index, metaPath);
      if (!metaNode || metaNode.kind !== "file") return { status: "idle", rawMeta: undefined };
      const bytes = metaNode.data ? await storage.readReadonly(metaNode.data) : new Uint8Array();
      return { status: "idle", rawMeta: decoder.decode(bytes) };
    } finally {
      if (storage) await storage.close().catch(() => undefined);
      else database.close();
    }
  });
  return result === "busy" ? { status: "busy" } : result;
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.addEventListener("success", () => resolve(), { once: true });
    request.addEventListener(
      "error",
      () => reject(request.error ?? new Error("Failed to delete IndexedDB database")),
      { once: true },
    );
  });
}

export async function deleteIdleWorkspaceStorage(name: string): Promise<"deleted" | "missing" | "busy"> {
  if (!globalThis.indexedDB || !globalThis.navigator?.locks) return "missing";
  const { OpfsStorage } = await import("waffle/fs/opfs");
  const result = await withIdleIndexedDbLock(name, async (): Promise<"deleted" | "missing" | "busy"> => {
    const opfs = await OpfsStorage.claimIdle(name);
    if (opfs === "busy") return "busy";
    try {
      const database = await openExistingDatabase(name);
      let removedIdb = false;
      if (database) {
        const valid = await isWorkspaceDatabase(database).finally(() => database.close());
        if (valid) {
          await deleteDatabase(name);
          removedIdb = true;
        }
      }
      const opfsOutcome = await opfs.remove();
      return removedIdb || opfsOutcome === "deleted" ? "deleted" : "missing";
    } finally {
      await opfs.release();
    }
  });
  return result;
}
