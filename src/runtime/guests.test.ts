import { expect, test } from "bun:test";
import { guestEntries, guestMismatch, guestPath, type GuestEntry } from "./guests";

const entry: GuestEntry = { source: "https://example.test/guest.wasm", sha256: "a".repeat(64), bytes: 8 };

test("a guest with the pinned size and hash is accepted", () => {
  expect(guestMismatch(entry, 8, "a".repeat(64))).toBeUndefined();
});

test("a guest of the wrong size or hash is refused with the reason", () => {
  expect(guestMismatch(entry, 9, "a".repeat(64))).toBe("expected 8 bytes, received 9");
  expect(guestMismatch(entry, 8, "b".repeat(64))).toContain("expected SHA-256");
});

test("a guest is served from a path that contains its hash", () => {
  const { sha256 } = guestEntries["bun-browser.wasm"];
  expect(guestPath("bun-browser.wasm")).toBe(`/guests/${sha256}/bun-browser.wasm`);
});

test("every pinned guest has a well-formed lock entry", () => {
  for (const pinned of Object.values(guestEntries)) {
    expect(pinned.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(pinned.bytes).toBeGreaterThan(8);
    expect(pinned.source).toStartWith("https://");
  }
});

// A pinned URL must keep serving the same bytes: the hash store names the hash, a release names
// its tag. Mutable sources such as a playground deploy are not allowed.
const RELEASE_ASSET = /^https:\/\/github\.com\/ShaulLavo\/[\w.-]+\/releases\/download\/[\w.-]+\/[\w.-]+$/;

test("every guest comes from an immutable source: the hash-addressed store or a tagged release", () => {
  for (const pinned of Object.values(guestEntries)) {
    const fromStore = pinned.source.startsWith(`https://bun-artifacts.shaulavo.dev/${pinned.sha256}/`);
    expect(fromStore || RELEASE_ASSET.test(pinned.source)).toBe(true);
  }
});
