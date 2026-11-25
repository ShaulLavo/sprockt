/** CRC-32 (IEEE 802.3, reflected 0xEDB88320) as ZIP and gzip use it. Slice-by-4 tables. */
const TABLES = buildTables();

function buildTables(): Uint32Array {
  const tables = new Uint32Array(256 * 4);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tables[n] = c >>> 0;
  }
  for (let n = 0; n < 256; n++) {
    for (let t = 1; t < 4; t++) {
      const previous = tables[(t - 1) * 256 + n] ?? 0;
      tables[t * 256 + n] = ((previous >>> 8) ^ (tables[previous & 0xff] ?? 0)) >>> 0;
    }
  }
  return tables;
}

/** Updates a running CRC; start with `crc32(bytes)` and pass the result back for the next chunk. */
export function crc32(bytes: Uint8Array, previous = 0): number {
  const t = TABLES;
  let crc = ~previous >>> 0;
  let i = 0;
  const end4 = bytes.byteLength & ~3;
  for (; i < end4; i += 4) {
    crc ^= (bytes[i]! | (bytes[i + 1]! << 8) | (bytes[i + 2]! << 16) | (bytes[i + 3]! << 24)) >>> 0;
    crc =
      t[768 + (crc & 0xff)]! ^
      t[512 + ((crc >>> 8) & 0xff)]! ^
      t[256 + ((crc >>> 16) & 0xff)]! ^
      t[crc >>> 24]!;
  }
  for (; i < bytes.byteLength; i++) crc = t[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return ~crc >>> 0;
}
