import { collectFiles, DEFAULT_EXCLUDED_DIRS } from "../fs/entries.ts";
import { normalizePath } from "../fs/path.ts";
import { DEFAULT_FILE_MODE, type FileEntry, type ProjectFs } from "../fs/types.ts";
import {
  arrayBufferBacked,
  compressBytes,
  concatBytes,
  hasCompressionStream,
  textEncoder,
} from "../bytes.ts";
import { crc32 } from "./crc32.ts";

export interface ZipOptions {
  /** Deflate files where it makes them smaller. Defaults to `true` when `CompressionStream("deflate-raw")` exists. */
  readonly compress?: boolean;
  /** Directory names left out at any depth. Defaults to `node_modules` and `.git`. */
  readonly excludeDirs?: readonly string[];
  /** Modification time written for every entry. Defaults to now. */
  readonly date?: Date;
}

export class ZipError extends Error {}

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const VERSION = 20;
/** "Made by" Unix, so readers honour the permission bits in the external attributes. */
const MADE_BY_UNIX = (3 << 8) | VERSION;
const FLAG_UTF8 = 0x0800;
const STORE = 0;
const DEFLATE = 8;
/** Below this, deflate's overhead outweighs any saving. */
const MIN_DEFLATE_BYTES = 64;
/** This writer has no ZIP64 support, so sizes, offsets and the entry count stay under the classic limits. */
const MAX_UINT32 = 0xffffffff;
const MAX_ENTRIES = 0xffff;
const MAX_NAME_BYTES = 0xffff;
const LOCAL_HEADER_BYTES = 30;

/** Zips a workspace directory, skipping `node_modules` and `.git` by default. */
export async function zipWorkspace(fs: ProjectFs, root = "", options: ZipOptions = {}): Promise<Blob> {
  const entries = await collectFiles(fs, root, { excludeDirs: options.excludeDirs });
  return createZipBlob(entries, options);
}

/** A ZIP of `entries` as one `Uint8Array`. */
export async function createZip(
  entries: Iterable<FileEntry>,
  options: ZipOptions = {},
): Promise<Uint8Array<ArrayBuffer>> {
  return concatBytes(await zipParts(entries, options));
}

/** A ZIP of `entries` as a `Blob`, built from parts without copying file data into one buffer. */
export async function createZipBlob(entries: Iterable<FileEntry>, options: ZipOptions = {}): Promise<Blob> {
  return new Blob(await zipParts(entries, options), { type: "application/zip" });
}

interface CentralRecord {
  readonly name: Uint8Array;
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly mode: number;
}

async function zipParts(
  entries: Iterable<FileEntry>,
  options: ZipOptions,
): Promise<Uint8Array<ArrayBuffer>[]> {
  const compress = options.compress ?? hasCompressionStream("deflate-raw");
  const excluded = new Set(options.excludeDirs ?? DEFAULT_EXCLUDED_DIRS);
  const { time, date } = dosDateTime(options.date ?? new Date());
  const kept = Array.from(entries).flatMap((entry) => {
    const path = zipPath(entry.path, excluded);
    return path === undefined ? [] : [{ entry, path }];
  });
  if (kept.length > MAX_ENTRIES) throw new ZipError(`a ZIP without ZIP64 holds at most ${MAX_ENTRIES} files`);
  // Files compress independently; only the offsets below depend on order.
  const encoded = await Promise.all(kept.map(({ entry, path }) => encodeEntry(entry, path, compress)));
  const offsets: number[] = [];
  let offset = 0;
  for (const record of encoded) {
    offsets.push(offset);
    offset += LOCAL_HEADER_BYTES + record.name.byteLength + record.data.byteLength;
  }
  const parts = encoded.flatMap((record) => [localHeader(record, time, date), record.data]);
  const central = encoded.map((record, index) => centralHeader(record, offsets[index] ?? 0, time, date));
  const centralSize = central.reduce((sum, header) => sum + header.byteLength, 0);
  if (offset + centralSize > MAX_UINT32) throw new ZipError("the ZIP would be larger than 4 GiB");
  return parts.concat(central, [endRecord(encoded.length, centralSize, offset)]);
}

/** The normalized path, or `undefined` when it sits in an excluded directory. */
function zipPath(path: string, excluded: ReadonlySet<string>): string | undefined {
  const normalized = normalizePath(path);
  if (normalized === undefined || normalized === "") throw new ZipError(`"${path}" is not a valid file path`);
  const dirs = normalized.split("/").slice(0, -1);
  return dirs.some((dir) => excluded.has(dir)) ? undefined : normalized;
}

async function encodeEntry(
  entry: FileEntry,
  path: string,
  compress: boolean,
): Promise<CentralRecord & { readonly data: Uint8Array<ArrayBuffer> }> {
  const size = entry.bytes.byteLength;
  if (size >= MAX_UINT32) throw new ZipError(`${path} is larger than 4 GiB`);
  const name = textEncoder.encode(path);
  // Both headers store the name length in 16 bits.
  if (name.byteLength > MAX_NAME_BYTES)
    throw new ZipError(`a file path is longer than ${MAX_NAME_BYTES} bytes`);
  const deflated =
    compress && size >= MIN_DEFLATE_BYTES ? await compressBytes(entry.bytes, "deflate-raw") : undefined;
  const useDeflate = deflated !== undefined && deflated.byteLength < size;
  const data = useDeflate ? deflated : arrayBufferBacked(entry.bytes);
  return {
    name,
    method: useDeflate ? DEFLATE : STORE,
    crc: crc32(entry.bytes),
    compressedSize: data.byteLength,
    size,
    mode: entry.mode ?? DEFAULT_FILE_MODE,
    data,
  };
}

function localHeader(record: CentralRecord, time: number, date: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(LOCAL_HEADER_BYTES + record.name.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, LOCAL_SIGNATURE, true);
  view.setUint16(4, VERSION, true);
  view.setUint16(6, FLAG_UTF8, true);
  view.setUint16(8, record.method, true);
  view.setUint16(10, time, true);
  view.setUint16(12, date, true);
  view.setUint32(14, record.crc, true);
  view.setUint32(18, record.compressedSize, true);
  view.setUint32(22, record.size, true);
  view.setUint16(26, record.name.byteLength, true);
  view.setUint16(28, 0, true);
  out.set(record.name, 30);
  return out;
}

function centralHeader(
  record: CentralRecord,
  offset: number,
  time: number,
  date: number,
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(46 + record.name.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, CENTRAL_SIGNATURE, true);
  view.setUint16(4, MADE_BY_UNIX, true);
  view.setUint16(6, VERSION, true);
  view.setUint16(8, FLAG_UTF8, true);
  view.setUint16(10, record.method, true);
  view.setUint16(12, time, true);
  view.setUint16(14, date, true);
  view.setUint32(16, record.crc, true);
  view.setUint32(20, record.compressedSize, true);
  view.setUint32(24, record.size, true);
  view.setUint16(28, record.name.byteLength, true);
  // Extra length, comment length, disk number start and internal attributes stay 0.
  view.setUint32(38, ((0o100000 | (record.mode & 0o7777)) << 16) >>> 0, true);
  view.setUint32(42, offset, true);
  out.set(record.name, 46);
  return out;
}

function endRecord(count: number, centralSize: number, centralOffset: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(22);
  const view = new DataView(out.buffer);
  view.setUint32(0, END_SIGNATURE, true);
  view.setUint16(8, count, true);
  view.setUint16(10, count, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, centralOffset, true);
  return out;
}

/** MS-DOS date and time in local time, which is what unzip tools display. Clamped to 1980..2107. */
function dosDateTime(when: Date): { time: number; date: number } {
  const year = Math.min(Math.max(when.getFullYear(), 1980), 2107);
  return {
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
  };
}
