import { expect, test } from "bun:test";
import { guestBytes, isGzip } from "./guest-bytes";

const wasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

test("a gzip body is decoded to the module", () => {
  const body = Bun.gzipSync(wasm);
  expect(isGzip(body)).toBe(true);
  expect(guestBytes(body)).toEqual(wasm);
});

test("a body the client already decoded is kept as it is", () => {
  expect(isGzip(wasm)).toBe(false);
  expect(guestBytes(wasm)).toBe(wasm);
});
