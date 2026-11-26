import { expect, test } from "bun:test";
import { previewOrigin, previewOriginId } from "bun-wasm/preview-origins";
import { forgetPreviewIdentity, previewIdentity } from "./identity";
import type { IdentityStore } from "./identity-store";

/** The IDE's own store, shared by every "tab": a claim is one step, as a transaction makes it. */
function sharedStore(): IdentityStore & { readonly nonces: Map<string, string> } {
  const nonces = new Map<string, string>();
  return {
    nonces,
    async claim(key, fresh) {
      const stored = nonces.get(key) ?? fresh;
      nonces.set(key, stored);
      return stored;
    },
    async forget(key) {
      nonces.delete(key);
    },
  };
}

const IDE = "https://sprockt.test";
const originOf = async (identity: string, port = 3000) =>
  previewOrigin({ domain: "previews.test" }, await previewOriginId(IDE, identity), port);

test("the identity is created once and is the same for every tab afterwards", async () => {
  const store = sharedStore();
  const first = await previewIdentity("abc", store);
  expect(await previewIdentity("abc", store)).toBe(first);
  // The host's key for the workspace is part of it, and the nonce is kept under that key.
  expect(first.split("\n")).toEqual(["sprockt-abc", store.nonces.get("sprockt-abc") ?? "missing"]);
  expect(store.nonces.get("sprockt-abc")).toMatch(/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/);
});

test("tabs that ask at the same moment get the same identity", async () => {
  const store = sharedStore();
  const asked = await Promise.all([
    previewIdentity("abc", store),
    previewIdentity("abc", store),
    previewIdentity("abc", store),
  ]);
  expect(new Set(asked).size).toBe(1);
});

test("two workspaces never derive the same preview origin, even with the same nonce", async () => {
  const store = sharedStore();
  // The worst case: the very same nonce under both keys. Nothing a workspace's programs write
  // can bring this about (the store is not in any workspace), and it still does not matter.
  store.nonces.set("sprockt-abc", "11111111-1111-4111-8111-111111111111");
  store.nonces.set("sprockt-xyz", "11111111-1111-4111-8111-111111111111");
  const abc = await previewIdentity("abc", store);
  const xyz = await previewIdentity("xyz", store);
  expect(abc).not.toBe(xyz);
  expect(await originOf(abc)).not.toBe(await originOf(xyz));
});

test("a workspace that was deleted and created again gets a new identity and new origins", async () => {
  const store = sharedStore();
  const first = await previewIdentity("abc", store);
  await forgetPreviewIdentity("sprockt-abc", store);
  const second = await previewIdentity("abc", store);
  expect(second).not.toBe(first);
  expect(await originOf(second)).not.toBe(await originOf(first));
  // Forgetting one workspace leaves the others' names alone.
  const other = await previewIdentity("xyz", store);
  await forgetPreviewIdentity("sprockt-abc", store);
  expect(await previewIdentity("xyz", store)).toBe(other);
});

test("a store that cannot forget does not fail the deletion it follows", async () => {
  const store: IdentityStore = {
    claim: async (_key, fresh) => fresh,
    forget: () => Promise.reject(new Error("no storage")),
  };
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args);
  try {
    await forgetPreviewIdentity("sprockt-abc", store);
  } finally {
    console.error = original;
  }
  expect(errors).toHaveLength(1);
});

test("a workspace id that is not one is refused before anything is stored", async () => {
  const store = sharedStore();
  expect(previewIdentity("../etc", store)).rejects.toThrow("Invalid workspace id");
  expect(store.nonces.size).toBe(0);
});
