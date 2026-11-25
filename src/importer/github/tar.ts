/**
 * A small streaming tar reader: ustar, POSIX pax (`x` and global `g` headers)
 * and GNU long names (`L`/`K`). That covers what GitHub's codeload archives
 * (made by `git archive`) contain. It reads one block at a time from a
 * `ReadableStream`, so a gzip `DecompressionStream` can feed it directly.
 */
// A streaming parser: every read waits for the bytes before it, so nothing can run in parallel.
/* oxlint-disable no-await-in-loop */
const BLOCK = 512;
/** Pax and GNU long-name bodies are metadata; anything larger is a broken or hostile archive. */
const MAX_META_BYTES = 1024 * 1024;
const nameDecoder = new TextDecoder();

export type TarEntryType = "file" | "directory" | "symlink" | "hardlink" | "other";

export interface TarHeader {
  readonly path: string;
  readonly type: TarEntryType;
  readonly mode: number;
  readonly size: number;
  readonly linkTarget: string;
}

export interface TarEntry extends TarHeader {
  /** The body, present only for files the caller's `accept` kept. */
  readonly bytes?: Uint8Array;
}

export interface TarReadOptions {
  /** Called before a file body is read; return `false` to skip the body. May throw to stop. */
  readonly accept?: (header: TarHeader) => boolean;
  /** Called with each global pax header (`git archive` puts the commit id in `comment`). */
  readonly onGlobal?: (records: ReadonlyMap<string, string>) => void;
}

export class TarError extends Error {}

export async function* readTar(
  stream: ReadableStream<Uint8Array>,
  options: TarReadOptions = {},
): AsyncGenerator<TarEntry> {
  const input = new BlockReader(stream);
  try {
    yield* readEntries(input, options);
  } finally {
    await input.close();
  }
}

interface Overrides {
  path?: string;
  linkTarget?: string;
  size?: number;
}

async function* readEntries(input: BlockReader, options: TarReadOptions): AsyncGenerator<TarEntry> {
  let overrides: Overrides = {};
  for (let block = await input.read(BLOCK); block; block = await input.read(BLOCK)) {
    if (isZeroBlock(block)) {
      // Read to the end of the stream so an upstream decompressor sees, and validates,
      // its trailer: success is only reported for a complete, intact archive.
      await input.drain();
      return;
    }
    const raw = parseHeader(block);
    const size = overrides.size ?? raw.size;
    if (raw.flag === "x" || raw.flag === "g" || raw.flag === "L" || raw.flag === "K") {
      const body = await readMeta(input, raw.size);
      overrides = applyMeta(raw.flag, body, overrides, options);
      continue;
    }
    const header: TarHeader = {
      path: overrides.path ?? raw.path,
      type: entryType(raw.flag),
      mode: raw.mode,
      size: bodySize(raw.flag, size),
      linkTarget: overrides.linkTarget ?? raw.linkTarget,
    };
    overrides = {};
    yield await readBody(input, header, size, options);
  }
  throw new TarError("archive ended without an end-of-archive marker");
}

/** Only regular files carry a body; for others the size field is informational. */
function bodySize(flag: string, size: number): number {
  return entryType(flag) === "file" ? size : 0;
}

async function readBody(
  input: BlockReader,
  header: TarHeader,
  size: number,
  options: TarReadOptions,
): Promise<TarEntry> {
  const padded = padToBlock(size);
  const keep = header.type === "file" && (options.accept?.(header) ?? true);
  if (!keep) {
    await input.skip(padded);
    return header;
  }
  if (size === 0) return { ...header, bytes: new Uint8Array(0) };
  const bytes = await input.read(size, true);
  if (!bytes) throw new TarError(`archive truncated inside ${header.path}`);
  await input.skip(padded - size);
  return { ...header, bytes };
}

async function readMeta(input: BlockReader, size: number): Promise<Uint8Array> {
  if (size > MAX_META_BYTES) throw new TarError(`metadata header of ${size} bytes is too large`);
  const body = await input.read(size, true);
  if (!body) throw new TarError("archive truncated inside a metadata header");
  await input.skip(padToBlock(size) - size);
  return body;
}

function applyMeta(flag: string, body: Uint8Array, overrides: Overrides, options: TarReadOptions): Overrides {
  if (flag === "L") return { ...overrides, path: cString(body) };
  if (flag === "K") return { ...overrides, linkTarget: cString(body) };
  const records = parsePax(body);
  if (flag === "g") {
    options.onGlobal?.(records);
    return overrides;
  }
  const size = records.get("size");
  return {
    path: records.get("path") ?? overrides.path,
    linkTarget: records.get("linkpath") ?? overrides.linkTarget,
    size: size === undefined ? overrides.size : parseDecimal(size),
  };
}

interface RawHeader {
  readonly path: string;
  readonly mode: number;
  readonly size: number;
  readonly flag: string;
  readonly linkTarget: string;
}

function parseHeader(block: Uint8Array): RawHeader {
  if (readOctal(block, 148, 8) !== checksum(block)) throw new TarError("bad tar header checksum");
  const name = cString(block.subarray(0, 100));
  const isUstar = cString(block.subarray(257, 262)) === "ustar";
  const prefix = isUstar ? cString(block.subarray(345, 500)) : "";
  return {
    path: prefix ? `${prefix}/${name}` : name,
    mode: readOctal(block, 100, 8) & 0o7777,
    size: readSize(block),
    flag: String.fromCharCode(block[156] ?? 0),
    linkTarget: cString(block.subarray(157, 257)),
  };
}

function entryType(flag: string): TarEntryType {
  if (flag === "0" || flag === "\0" || flag === "7") return "file";
  if (flag === "5") return "directory";
  if (flag === "2") return "symlink";
  if (flag === "1") return "hardlink";
  return "other";
}

function checksum(block: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : (block[i] ?? 0);
  return sum;
}

function readSize(block: Uint8Array): number {
  // GNU base-256: high bit of the first byte set, big-endian binary in the rest.
  if (((block[124] ?? 0) & 0x80) === 0) return readOctal(block, 124, 12);
  let size = (block[124] ?? 0) & 0x7f;
  for (let i = 125; i < 136; i++) size = size * 256 + (block[i] ?? 0);
  if (!Number.isSafeInteger(size)) throw new TarError("tar entry size is too large");
  return size;
}

function readOctal(block: Uint8Array, offset: number, length: number): number {
  const text = cString(block.subarray(offset, offset + length)).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new TarError(`bad octal field "${text}"`);
  return Number.parseInt(text, 8);
}

function parseDecimal(text: string): number {
  if (!/^\d+$/.test(text)) throw new TarError(`bad pax size "${text}"`);
  return Number(text);
}

/** Pax records are `"<length> <key>=<value>\n"`, where length counts the whole record in bytes. */
function parsePax(body: Uint8Array): Map<string, string> {
  const records = new Map<string, string>();
  let offset = 0;
  while (offset < body.byteLength) {
    const space = body.indexOf(0x20, offset);
    const length = space === -1 ? Number.NaN : Number(nameDecoder.decode(body.subarray(offset, space)));
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > body.byteLength) {
      throw new TarError("bad pax record");
    }
    const record = nameDecoder.decode(body.subarray(space + 1, offset + length - 1));
    const equals = record.indexOf("=");
    if (equals > 0) records.set(record.slice(0, equals), record.slice(equals + 1));
    offset += length;
  }
  return records;
}

function cString(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return nameDecoder.decode(end === -1 ? bytes : bytes.subarray(0, end));
}

function isZeroBlock(block: Uint8Array): boolean {
  return block.every((byte) => byte === 0);
}

function padToBlock(size: number): number {
  return Math.ceil(size / BLOCK) * BLOCK;
}

/** Hands out exact byte counts from a stream of arbitrarily sized chunks. */
class BlockReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  #chunk: Uint8Array = new Uint8Array(0);
  #offset = 0;
  #done = false;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.#reader = stream.getReader();
  }

  /**
   * Exactly `size` bytes, or `undefined` at a clean end of stream. `copy` returns
   * an owned array instead of a view into the stream's chunk.
   */
  async read(size: number, copy = false): Promise<Uint8Array | undefined> {
    if (!(await this.#fill())) return undefined;
    const available = this.#chunk.byteLength - this.#offset;
    if (available >= size) {
      const view = this.#chunk.subarray(this.#offset, this.#offset + size);
      this.#offset += size;
      return copy ? view.slice() : view;
    }
    return this.#readAcrossChunks(size);
  }

  async skip(size: number): Promise<void> {
    let remaining = size;
    while (remaining > 0) {
      if (!(await this.#fill())) throw new TarError("archive truncated");
      const step = Math.min(remaining, this.#chunk.byteLength - this.#offset);
      this.#offset += step;
      remaining -= step;
    }
  }

  /** Discards everything up to the end of the stream (the end-of-archive padding). */
  async drain(): Promise<void> {
    while (await this.#fill()) this.#offset = this.#chunk.byteLength;
  }

  async close(): Promise<void> {
    if (!this.#done) await this.#reader.cancel().catch(() => undefined);
    this.#reader.releaseLock();
  }

  async #readAcrossChunks(size: number): Promise<Uint8Array> {
    const out = new Uint8Array(size);
    let filled = 0;
    while (filled < size) {
      if (!(await this.#fill())) throw new TarError("archive truncated");
      const step = Math.min(size - filled, this.#chunk.byteLength - this.#offset);
      out.set(this.#chunk.subarray(this.#offset, this.#offset + step), filled);
      this.#offset += step;
      filled += step;
    }
    return out;
  }

  /** Makes at least one unread byte available; `false` at end of stream. */
  async #fill(): Promise<boolean> {
    while (this.#offset >= this.#chunk.byteLength) {
      if (this.#done) return false;
      const next = await this.#reader.read();
      if (next.done) {
        this.#done = true;
        return false;
      }
      this.#chunk = next.value;
      this.#offset = 0;
    }
    return true;
  }
}
