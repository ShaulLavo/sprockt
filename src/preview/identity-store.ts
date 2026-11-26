// Where preview identities' nonces are kept: a small IndexedDB database of the IDE's origin.
// It is the IDE's own storage: a program in a workspace reaches its workspace's filesystem and
// nothing else, and a previewed page on an isolated origin reaches none of the IDE's storage.
//
// IndexedDB, not localStorage: a read-then-write has to be one step for every tab of the
// origin, and only a transaction gives that.

/** Not a workspace's storage name: those start with `sprockt-` and the landing page lists them. */
const DATABASE = "preview-identities.sprockt";
const STORE = "nonces";

export interface IdentityStore {
  /**
   * The nonce stored under `key`. When there is none, `fresh` is stored and returned. Tabs that
   * claim the same key at the same moment all get the one that was stored first.
   */
  claim(key: string, fresh: string): Promise<string>;
  /** Removes the nonce under `key`. Rejects when it could not: the caller must not go on as if it had. */
  forget(key: string): Promise<void>;
}

function settled<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB request failed")), {
      once: true,
    });
  });
}

function finished(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    const failed = (): void => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("error", failed, { once: true });
    transaction.addEventListener("abort", failed, { once: true });
  });
}

function open(factory: IDBFactory): Promise<IDBDatabase> {
  const request = factory.open(DATABASE, 1);
  request.addEventListener("upgradeneeded", () => request.result.createObjectStore(STORE), { once: true });
  return settled(request);
}

/** Runs `work` in one read-write transaction, which no other tab's transaction can interleave with. */
async function inTransaction<T>(
  factory: IDBFactory,
  work: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  const database = await open(factory);
  try {
    const transaction = database.transaction(STORE, "readwrite");
    const done = finished(transaction);
    // When `work` fails first, its error is the one reported; this one must not go unhandled.
    done.catch(() => {});
    const result = await work(transaction.objectStore(STORE));
    await done;
    return result;
  } finally {
    database.close();
  }
}

export function browserIdentityStore(factory: IDBFactory = globalThis.indexedDB): IdentityStore {
  return {
    claim: (key, fresh) =>
      inTransaction(factory, async (store) => {
        const stored: unknown = await settled(store.get(key));
        if (typeof stored === "string" && stored !== "") return stored;
        await settled(store.put(fresh, key));
        return fresh;
      }),
    forget: (key) => inTransaction(factory, async (store) => void (await settled(store.delete(key)))),
  };
}
