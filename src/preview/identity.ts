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
// - Deleting a workspace forgets its nonce (`forgetPreviewIdentity` in identity-store.ts,
//   called where storage is deleted), so a workspace created again under the same id gets new
//   names, and never the cookies or the storage its predecessor's pages left on their origins.
import { storageName } from "../workspace/paths";
import { browserIdentityStore, type IdentityStore } from "./identity-store";

/** The identity of the workspace with this id, created on first use. */
export async function previewIdentity(
  workspace: string,
  store: IdentityStore = browserIdentityStore(),
): Promise<string> {
  const key = storageName(workspace);
  const nonce = await store.claim(key, crypto.randomUUID());
  return `${key}\n${nonce}`;
}
