// How a workspace's storage is deleted, so that everything the IDE keeps about that storage
// outside it goes in the same step. Today that is the workspace's preview identity
// (preview/identity.ts), whose nonce must never outlive the storage it was made for:
//
// - A nonce is claimed only by a tab that has the storage open (workspace/session/index.ts), and a
//   claim that is out when the tab closes is stored before the tab lets go of the storage
//   (preview/isolated.ts `dispose`).
// - A nonce is forgotten only here, while the storage is held idle: no tab has it open, and
//   none can open it until this is over. Waffle holds every open tab off while these locks are
//   held: an attaching tab never steals them, and neither does an ordinary open
//   (runtime/boot.ts). Only a takeover the person confirmed would, and the attach policy has
//   none (runtime/tab-policy.ts).
//
// The two cannot interleave. A tab that recreates the workspace right after a delete opens the
// storage only once the delete has let go, by which time the old nonce is gone, so it can only
// claim a new one, and every tab after it reads that same one. Forgetting comes first: if it
// fails, the storage is not deleted and the delete fails, instead of reporting a workspace gone
// whose identity is still there for the next one of that name. If removing the storage fails
// after that, the workspace stays with a new identity at its next open: new preview origins,
// never an old one.

/** The steps of one deletion. `Held` is whatever holding the storage idle hands to the removal. */
export interface StorageDeletion<Held> {
  /**
   * Runs `work` while no tab has the storage open and none can open it. Resolves "busy",
   * without running it, when a tab has the storage open.
   */
  whileIdle<Result>(work: (held: Held) => Promise<Result>): Promise<Result | "busy">;
  /** Forgets the IDE's own records of this storage. Rejects when it could not. */
  forgetIdentity(): Promise<void>;
  /** Deletes the storage itself. */
  removeStorage(held: Held): Promise<"deleted" | "missing">;
}

export function deleteStorage<Held>(steps: StorageDeletion<Held>): Promise<"deleted" | "missing" | "busy"> {
  return steps.whileIdle(async (held) => {
    await steps.forgetIdentity();
    return steps.removeStorage(held);
  });
}
