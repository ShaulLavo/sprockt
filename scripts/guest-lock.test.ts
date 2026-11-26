import { expect, test } from "bun:test";
import { BUN_WASM_ASSET } from "bun-wasm/asset";
import lock from "../guests.lock.json";
import manifest from "../package.json";

// The host code (the bun-wasm package) and the guest it drives move together. The package
// names its guest by hash, so a pin that moved without the lock, or a lock that moved without
// the pin, fails here and not as a trap in someone's browser.
test("the lock names the bun-wasm commit that package.json pins", () => {
  expect(manifest.dependencies["bun-wasm"]).toEndWith(`#${lock.bunWasm}`);
});

test("the lock pins the Bun guest that the pinned bun-wasm package names", () => {
  const guest = lock.guests["bun-browser.wasm"];
  expect(BUN_WASM_ASSET).toEqual({
    kind: "single",
    core: { url: guest.source, sha256: guest.sha256, bytes: guest.bytes },
  });
});
