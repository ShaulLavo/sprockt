/** Test-only tar writer: builds archives with ustar, pax and GNU long-name headers. */
import { concatBytes, textEncoder } from "../../lib/bytes.ts";

export interface TarFixtureEntry {
  readonly path: string;
  readonly type?: "0" | "5" | "2" | "x" | "g" | "L";
  readonly bytes?: Uint8Array | string;
  readonly mode?: number;
  readonly linkTarget?: string;
  /** Split a long path into the ustar `prefix` field instead of `name`. */
  readonly ustarPrefix?: string;
}

export function tarHeader(entry: TarFixtureEntry, size: number): Uint8Array {
  const block = new Uint8Array(512);
  writeString(block, 0, 100, entry.path);
  writeOctal(block, 100, 8, entry.mode ?? 0o644);
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  writeOctal(block, 124, 12, size);
  writeOctal(block, 136, 12, 0);
  block[156] = (entry.type ?? "0").charCodeAt(0);
  writeString(block, 157, 100, entry.linkTarget ?? "");
  writeString(block, 257, 6, "ustar");
  writeString(block, 263, 2, "00");
  writeString(block, 345, 155, entry.ustarPrefix ?? "");
  block.fill(0x20, 148, 156);
  const sum = block.reduce((total, byte) => total + byte, 0);
  writeString(block, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return block;
}

export function paxBody(records: Readonly<Record<string, string>>): Uint8Array {
  const lines = Object.entries(records).map(([key, value]) => {
    const body = ` ${key}=${value}\n`;
    const bodyLength = textEncoder.encode(body).byteLength;
    let length = bodyLength + 1;
    while (bodyLength + String(length).length !== length) length = bodyLength + String(length).length;
    return `${length}${body}`;
  });
  return textEncoder.encode(lines.join(""));
}

export function buildTar(entries: readonly TarFixtureEntry[], { end = true } = {}): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    const bytes =
      typeof entry.bytes === "string" ? textEncoder.encode(entry.bytes) : (entry.bytes ?? new Uint8Array(0));
    parts.push(
      tarHeader(entry, bytes.byteLength),
      bytes,
      new Uint8Array((512 - (bytes.byteLength % 512)) % 512),
    );
  }
  if (end) parts.push(new Uint8Array(1024));
  return concatBytes(parts);
}

/** A stream that delivers `bytes` in chunks of `chunkSize`, to exercise reads across chunk boundaries. */
export function chunkedStream(bytes: Uint8Array, chunkSize: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

function writeString(block: Uint8Array, offset: number, length: number, text: string): void {
  block.set(textEncoder.encode(text).subarray(0, length), offset);
}

function writeOctal(block: Uint8Array, offset: number, length: number, value: number): void {
  writeString(block, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}
