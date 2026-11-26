// A workspace's preview identity: what its preview host names are derived from (isolated-origins.ts).
//
// It is the host's own key for the workspace (the name of its storage) and a random nonce made
// when the identity is first asked for. Both live outside the workspace: the nonce is kept in
// a database of the IDE's origin (identity-store.ts), never in the workspace's filesystem,
// which every program in the workspace can write.
//
// - The key is part of the identity, so two workspaces never derive the same host names,
//   whatever else is equal.
// - Every tab of a workspace reads the same nonce, so every tab derives the same names.
// - The nonce lives exactly as long as the storage it was made for
//   (workspace/storage-lifecycle.ts). It is claimed only by a tab that has the storage open,
//   and forgotten only by the one deletion every workspace goes through, in the same step and
//   under the storage's locks, where no tab has the storage open or can open it. So a workspace
//   created again under the same id can only claim a new nonce: it never gets the names where
//   its predecessor's pages left their cookies and storage.
import { storageName } from "../workspace/paths";
import { browserIdentityStore, type IdentityStore } from "./identity-store";

/**
 * The identity of the workspace with this id, created on first use. Only for a tab that has
 * the workspace's storage open: that is what keeps a claim from meeting a deletion.
 */
export async function previewIdentity(
  workspace: string,
  store: IdentityStore = browserIdentityStore(),
): Promise<string> {
  const key = storageName(workspace);
  const nonce = await store.claim(key, crypto.randomUUID());
  return `${key}\n${nonce}`;
}
