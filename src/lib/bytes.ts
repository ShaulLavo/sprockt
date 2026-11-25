export const textEncoder = new TextEncoder();
// `ignoreBOM` keeps a leading byte order mark in the string, so decoding and re-encoding
// gives back the same bytes. Callers that parse the text strip it themselves.
const strictDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Decodes UTF-8 byte for byte (a BOM stays as U+FEFF), or `undefined` when the bytes are not valid UTF-8. */
export function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return strictDecoder.decode(bytes);
  } catch {
    return undefined;
  }
}

/** The same bytes typed as `ArrayBuffer`-backed (what `Blob` takes), copying only when shared memory backs them. */
export function arrayBufferBacked(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer ? (bytes as Uint8Array<ArrayBuffer>) : new Uint8Array(bytes);
}

export function concatBytes(parts: readonly Uint8Array[], total?: number): Uint8Array<ArrayBuffer> {
  const size = total ?? parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

export class ByteLimitError extends Error {
  constructor(readonly limit: number) {
    super(`stream is larger than ${limit} bytes`);
  }
}

/** Reads a whole stream, throwing `ByteLimitError` as soon as it passes `limit` bytes. */
export async function readAllBytes(
  stream: ReadableStream<Uint8Array>,
  limit = Number.POSITIVE_INFINITY,
): Promise<Uint8Array<ArrayBuffer>> {
  const parts: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  try {
    // Chunks arrive one after another; there is nothing to run in parallel.
    // oxlint-disable-next-line no-await-in-loop
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      total += next.value.byteLength;
      if (total > limit) throw new ByteLimitError(limit);
      parts.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return concatBytes(parts, total);
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

export function hasCompressionStream(format: CompressionFormat): boolean {
  if (typeof CompressionStream !== "function") return false;
  try {
    // The constructor throws for a format the browser does not support.
    return typeof new CompressionStream(format) === "object";
  } catch {
    return false;
  }
}

/** A narrow `fetch` signature that test doubles and Worker `fetch` both satisfy. */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export const defaultFetch: Fetch = (input, init) => fetch(input, init);

type ByteTransform = ReadableWritablePair<Uint8Array<ArrayBuffer>, Uint8Array>;

// The DOM typings declare the writable side as `BufferSource`, which TypeScript will not
// accept for a `ReadableStream<Uint8Array>`; the runtime takes any Uint8Array.
export function compressionStream(format: CompressionFormat): ByteTransform {
  return new CompressionStream(format) as unknown as ByteTransform;
}

export function decompressionStream(format: CompressionFormat): ByteTransform {
  return new DecompressionStream(format) as unknown as ByteTransform;
}

export function compressBytes(
  bytes: Uint8Array,
  format: CompressionFormat,
): Promise<Uint8Array<ArrayBuffer>> {
  return readAllBytes(streamOf(bytes).pipeThrough(compressionStream(format)));
}

export async function decompressBytes(
  bytes: Uint8Array,
  format: CompressionFormat,
  limit?: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const stream = streamOf(bytes).pipeThrough(decompressionStream(format));
  return readAllBytes(stream, limit);
}

const BASE64_CHUNK = 0x8000;

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decodes base64url (padding optional), or returns `undefined` for malformed input. */
export function fromBase64Url(text: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return undefined;
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
