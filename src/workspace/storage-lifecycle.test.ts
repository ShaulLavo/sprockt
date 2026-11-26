import { expect, test } from "bun:test";
import { previewIdentity } from "../preview/identity";
import type { IdentityStore } from "../preview/identity-store";
import { deleteStorage, type StorageDeletion } from "./storage-lifecycle";

/** Lets everything that can run now run. */
const settle = async () => {
  for (let turn = 0; turn < 30; turn++) {
    // oxlint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
};

/**
 * One workspace as the browser holds it: its storage, the locks around it, and the IDE's store
 * of nonces, all shared by every "tab". A tab that opens the workspace waits while a deletion
 * holds the storage, and a deletion finds the storage busy while a tab has it open.
 */
function browser() {
  const nonces = new Map<string, string>();
  const store: IdentityStore & { failing: boolean } = {
    failing: false,
    async claim(key, fresh) {
      const stored = nonces.get(key) ?? fresh;
      nonces.set(key, stored);
      return stored;
    },
    async forget(key) {
      if (store.failing) throw new Error("the nonce store is not available");
      nonces.delete(key);
    },
  };
  const world = {
    store,
    nonces,
    exists: false,
    openTabs: 0,
    held: false,
    removals: 0,
    /** Set by a test to stop a deletion in the middle; resolving it lets the deletion go on. */
    pause: undefined as PromiseWithResolvers<void> | undefined,
    waiting: [] as (() => void)[],
    /** A tab opens the workspace, creating its storage when there is none, and claims its identity. */
    async openTab(): Promise<{ identity: string; close(): void }> {
      // The storage is held by a deletion: opening waits until it lets go.
      // oxlint-disable-next-line no-await-in-loop
      while (world.held) await new Promise<void>((resolve) => world.waiting.push(resolve));
      world.openTabs++;
      world.exists = true;
      const identity = await previewIdentity("abc", store);
      return { identity, close: () => void world.openTabs-- };
    },
    async whileIdle<Result>(work: (held: undefined) => Promise<Result>): Promise<Result | "busy"> {
      if (world.openTabs > 0 || world.held) return "busy";
      world.held = true;
      try {
        return await work(undefined);
      } finally {
        world.held = false;
        for (const wake of world.waiting.splice(0)) wake();
      }
    },
    async removeStorage(): Promise<"deleted" | "missing"> {
      await world.pause?.promise;
      world.removals++;
      const existed = world.exists;
      world.exists = false;
      return existed ? "deleted" : "missing";
    },
  };
  return world;
}

type World = ReturnType<typeof browser>;

const deletion = (world: World): StorageDeletion<undefined> => ({
  whileIdle: (work) => world.whileIdle(work),
  forgetIdentity: () => world.store.forget("sprockt-abc"),
  removeStorage: () => world.removeStorage(),
});

test("a workspace deleted and created again gets a new identity", async () => {
  const world = browser();
  const first = await world.openTab();
  first.close();
  expect(await deleteStorage(deletion(world))).toBe("deleted");
  expect(world.nonces.size).toBe(0);
  const second = await world.openTab();
  expect(second.identity).not.toBe(first.identity);
});

test("a tab that recreates the workspace while it is being deleted cannot claim the old nonce", async () => {
  const world = browser();
  const before = await world.openTab();
  before.close();

  // The deletion is under way: the storage is held, and its removal has not finished.
  world.pause = Promise.withResolvers<void>();
  const deleting = deleteStorage(deletion(world));
  await settle();
  expect(world.held).toBe(true);

  // Another tab opens the same id right now. It cannot have the storage yet, so it has claimed
  // nothing: the old nonce is already gone, and no new one exists.
  const recreating = world.openTab();
  await settle();
  expect(world.openTabs).toBe(0);
  expect(world.nonces.size).toBe(0);

  world.pause.resolve();
  expect(await deleting).toBe("deleted");
  const recreated = await recreating;
  expect(recreated.identity).not.toBe(before.identity);
  // Every tab after it reads the same one: the tabs of the new workspace agree.
  const later = await world.openTab();
  expect(later.identity).toBe(recreated.identity);
  expect(world.nonces.size).toBe(1);
});

test("forgetting after the storage was let go is the gap this closes", async () => {
  // The order an earlier version had: delete the storage under its locks, forget the nonce
  // afterwards. A tab that opens in between claims the old nonce and keeps it for its session.
  const world = browser();
  const before = await world.openTab();
  before.close();
  expect(await world.whileIdle(() => world.removeStorage())).toBe("deleted");
  const inTheGap = await world.openTab();
  await world.store.forget("sprockt-abc");
  const later = await world.openTab();
  // The recreated workspace runs on its predecessor's identity, and its two tabs disagree.
  expect(inTheGap.identity).toBe(before.identity);
  expect(later.identity).not.toBe(inTheGap.identity);
});

test("a workspace that is open is not deleted, and keeps its identity", async () => {
  const world = browser();
  const tab = await world.openTab();
  expect(await deleteStorage(deletion(world))).toBe("busy");
  expect(world.removals).toBe(0);
  expect(world.exists).toBe(true);
  // Another tab still reads the identity the open one has.
  const other = await world.openTab();
  expect(other.identity).toBe(tab.identity);
});

test("an identity that cannot be forgotten fails the deletion, and the storage stays", async () => {
  const world = browser();
  const tab = await world.openTab();
  tab.close();
  world.store.failing = true;
  expect(deleteStorage(deletion(world))).rejects.toThrow("not available");
  await settle();
  // Not reported as deleted, and not half done: the workspace is as it was, identity and all.
  expect(world.removals).toBe(0);
  expect(world.exists).toBe(true);
  expect(world.held).toBe(false);
  const again = await world.openTab();
  expect(again.identity).toBe(tab.identity);
});

test("storage that is already gone still has its identity forgotten", async () => {
  const world = browser();
  world.nonces.set("sprockt-abc", "11111111-1111-4111-8111-111111111111");
  expect(await deleteStorage(deletion(world))).toBe("missing");
  expect(world.nonces.size).toBe(0);
});
