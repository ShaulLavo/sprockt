import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { writeFiles } from "../fs/entries.ts";
import { MemoryFs } from "../fs/memory.ts";
import type { FileEntry } from "../fs/types.ts";
import { textEncoder } from "../bytes.ts";
import { crc32 } from "./crc32.ts";
import { createZip, createZipBlob, zipWorkspace, ZipError } from "./zip.ts";

const file = (path: string, content: string | Uint8Array, mode?: number): FileEntry => ({
  path,
  bytes: typeof content === "string" ? textEncoder.encode(content) : content,
  mode,
});

function randomBytes(size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let offset = 0; offset < size; offset += 65536)
    crypto.getRandomValues(out.subarray(offset, offset + 65536));
  return out;
}

const decode = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);

/** Reads the central directory: name, method, external attributes. */
function centralEntries(zip: Uint8Array): { name: string; method: number; mode: number }[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.byteLength - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const out: { name: string; method: number; mode: number }[] = [];
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(offset, true)).toBe(0x02014b50);
    expect(view.getUint16(offset + 8, true) & 0x0800).toBe(0x0800);
    const nameLength = view.getUint16(offset + 28, true);
    out.push({
      name: decode(zip.subarray(offset + 46, offset + 46 + nameLength)),
      method: view.getUint16(offset + 10, true),
      mode: (view.getUint32(offset + 38, true) >>> 16) & 0o7777,
    });
    offset += 46 + nameLength;
  }
  return out;
}

describe("crc32", () => {
  test("matches the standard check value and Bun's implementation", () => {
    expect(crc32(textEncoder.encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
    for (const size of [1, 3, 4, 5, 1000, 65537]) {
      const bytes = randomBytes(size);
      expect(crc32(bytes)).toBe(Bun.hash.crc32(bytes));
    }
  });

  test("continues across chunks", () => {
    const bytes = randomBytes(10_001);
    expect(crc32(bytes.subarray(4567), crc32(bytes.subarray(0, 4567)))).toBe(crc32(bytes));
  });
});

describe("createZip", () => {
  const entries = [
    file("README.md", "# Hello\n".repeat(50)),
    file("src/main.ts", "console.log('hi')\n"),
    file("src/ünïcødé 名前.txt", "utf-8 names"),
    file("bin/run.sh", "#!/bin/sh\necho run\n", 0o755),
    file("empty.txt", ""),
    file("random.bin", randomBytes(5000)),
    file("node_modules/dep/index.js", "skip me"),
    file("packages/a/node_modules/x.js", "skip me too"),
    file(".git/HEAD", "ref: refs/heads/main"),
    file(".gitignore", "node_modules\n"),
  ];
  const kept = entries.filter((entry) => !/(^|\/)(node_modules|\.git)\//.test(entry.path));

  test("round-trips through an independent reader, deflated", async () => {
    const zip = await createZip(entries, { date: new Date(2026, 10, 25, 12, 30, 10) });
    const unzipped = unzipSync(zip);
    expect(Object.keys(unzipped).sort()).toEqual(kept.map((entry) => entry.path).sort());
    for (const entry of kept) expect(unzipped[entry.path]).toEqual(new Uint8Array(entry.bytes));
    const central = centralEntries(zip);
    const byName = new Map(central.map((entry) => [entry.name, entry]));
    expect(byName.get("README.md")?.method).toBe(8);
    // Random data does not shrink, so it is stored; tiny files are stored too.
    expect(byName.get("random.bin")?.method).toBe(0);
    expect(byName.get("src/main.ts")?.method).toBe(0);
    expect(byName.get("bin/run.sh")?.mode).toBe(0o755);
    expect(byName.get("README.md")?.mode).toBe(0o644);
  });

  test("store-only output round-trips too", async () => {
    const zip = await createZip(entries, { compress: false });
    expect(centralEntries(zip).every((entry) => entry.method === 0)).toBe(true);
    const unzipped = unzipSync(zip);
    for (const entry of kept) expect(unzipped[entry.path]).toEqual(new Uint8Array(entry.bytes));
  });

  test("custom exclusions replace the defaults", async () => {
    const zip = await createZip(entries, { excludeDirs: ["src"] });
    const names = Object.keys(unzipSync(zip));
    expect(names).toContain("node_modules/dep/index.js");
    expect(names.some((name) => name.startsWith("src/"))).toBe(false);
  });

  test("an empty ZIP is valid", async () => {
    const zip = await createZip([]);
    expect(zip.byteLength).toBe(22);
    expect(unzipSync(zip)).toEqual({});
  });

  test("refuses paths that escape the archive", async () => {
    await expect(createZip([file("../evil", "x")])).rejects.toBeInstanceOf(ZipError);
    await expect(createZip([file("", "x")])).rejects.toBeInstanceOf(ZipError);
  });

  test("refuses a name longer than the 16-bit length field instead of truncating it", async () => {
    // 21,846 three-byte characters encode to 65,538 bytes; just under the limit is fine.
    await expect(createZip([file("€".repeat(21_846), "x")])).rejects.toThrow("longer than 65535 bytes");
    const ok = await createZip([file("€".repeat(21_845), "x")]);
    expect(Object.keys(unzipSync(ok))).toEqual(["€".repeat(21_845)]);
  });

  test("Blob output has the same bytes", async () => {
    const date = new Date(2026, 0, 1);
    const blob = await createZipBlob(kept, { date });
    expect(blob.type).toBe("application/zip");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(await createZip(kept, { date }));
  });

  test("the system unzip accepts it", async () => {
    const which = Bun.spawnSync(["which", "unzip"]);
    if (which.exitCode !== 0) return;
    const dir = mkdtempSync(join(tmpdir(), "sprockt-zip-"));
    try {
      const path = join(dir, "out.zip");
      writeFileSync(path, await createZip(entries));
      const result = Bun.spawnSync(["unzip", "-t", path]);
      expect(result.stdout.toString()).toContain("No errors detected");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("zipWorkspace", () => {
  test("zips a filesystem directory, skipping node_modules and .git", async () => {
    const fs = new MemoryFs();
    await writeFiles(
      fs,
      [
        file("index.html", "<h1>x</h1>"),
        file("node_modules/a/b.js", "x"),
        file(".git/config", "x"),
        file("src/a.ts", "a", 0o755),
      ],
      "app",
    );
    const blob = await zipWorkspace(fs, "app");
    const unzipped = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    expect(Object.keys(unzipped).sort()).toEqual(["index.html", "src/a.ts"]);
  });
});
