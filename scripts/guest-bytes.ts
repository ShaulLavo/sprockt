// The guest store serves `.wasm.gz` files with `Content-Encoding: gzip`. A client that asks for
// gzip may get the body decoded (Bun's fetch decodes it) or not, so this accepts both: a body
// that still starts with the gzip magic number is gunzipped. A WebAssembly module starts with
// `\0asm`, so the two cannot be confused.

const GZIP_MAGIC = [0x1f, 0x8b] as const;

export function isGzip(bytes: Uint8Array): boolean {
  return bytes[0] === GZIP_MAGIC[0] && bytes[1] === GZIP_MAGIC[1];
}

/** The module's own bytes, whatever encoding the download kept. */
export function guestBytes(body: Uint8Array<ArrayBuffer>): Uint8Array {
  return isGzip(body) ? Bun.gunzipSync(body) : body;
}
