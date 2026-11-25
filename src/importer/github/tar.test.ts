import { describe, expect, test } from "bun:test";
import { buildTar, chunkedStream, paxBody, tarHeader } from "./tar-writer.ts";
import { readTar, TarError, type TarEntry } from "./tar.ts";

async function collect(
  bytes: Uint8Array,
  chunkSize = 4096,
  accept?: (path: string) => boolean,
): Promise<TarEntry[]> {
  const out: TarEntry[] = [];
  const options = accept ? { accept: (header: { path: string }) => accept(header.path) } : {};
  for await (const entry of readTar(chunkedStream(bytes, chunkSize), options)) out.push(entry);
  return out;
}

const text = (entry: TarEntry | undefined) => new TextDecoder().decode(entry?.bytes);

describe("readTar", () => {
  test("reads files, directories and symlinks with modes", async () => {
    const archive = buildTar([
      { path: "repo/", type: "5", mode: 0o755 },
      { path: "repo/a.txt", bytes: "hello" },
      { path: "repo/run.sh", bytes: "#!/bin/sh\n", mode: 0o755 },
      { path: "repo/link", type: "2", linkTarget: "a.txt" },
      { path: "repo/empty", bytes: "" },
    ]);
    const entries = await collect(archive);
    expect(entries.map((entry) => [entry.path, entry.type, entry.mode])).toEqual([
      ["repo/", "directory", 0o755],
      ["repo/a.txt", "file", 0o644],
      ["repo/run.sh", "file", 0o755],
      ["repo/link", "symlink", 0o644],
      ["repo/empty", "file", 0o644],
    ]);
    expect(text(entries[1])).toBe("hello");
    expect(entries[3]?.linkTarget).toBe("a.txt");
    expect(entries[4]?.bytes?.byteLength).toBe(0);
  });

  test("handles bodies split across many small chunks", async () => {
    const big = new Uint8Array(70_000).map((_, index) => index % 251);
    const archive = buildTar([
      { path: "x/big.bin", bytes: big },
      { path: "x/small", bytes: "ok" },
    ]);
    const runs = await Promise.all([1, 7, 511, 513, 65536].map((chunkSize) => collect(archive, chunkSize)));
    for (const entries of runs) {
      expect(entries[0]?.bytes).toEqual(big);
      expect(text(entries[1])).toBe("ok");
    }
  });

  test("applies pax path, linkpath and size overrides and reports global headers", async () => {
    const longPath = `repo/${"deep/".repeat(40)}file-ü.txt`;
    const globals: string[] = [];
    const archive = buildTar([
      { path: "pax_global_header", type: "g", bytes: paxBody({ comment: "abc123" }) },
      { path: "PaxHeader", type: "x", bytes: paxBody({ path: longPath }) },
      { path: "truncated-name", bytes: "long" },
      { path: "PaxHeader", type: "x", bytes: paxBody({ linkpath: "target/".repeat(20) }) },
      { path: "repo/l", type: "2" },
      { path: "repo/after", bytes: "after" },
    ]);
    const entries: TarEntry[] = [];
    const stream = chunkedStream(archive, 100);
    for await (const entry of readTar(stream, {
      onGlobal: (records) => globals.push(records.get("comment") ?? ""),
    })) {
      entries.push(entry);
    }
    expect(globals).toEqual(["abc123"]);
    expect(entries.map((entry) => entry.path)).toEqual([longPath, "repo/l", "repo/after"]);
    expect(entries[1]?.linkTarget).toBe("target/".repeat(20));
    expect(text(entries[2])).toBe("after");
  });

  test("reads GNU long names and ustar prefixes", async () => {
    const longName = `r/${"n".repeat(150)}`;
    const archive = buildTar([
      { path: "././@LongLink", type: "L", bytes: `${longName}\0` },
      { path: "short", bytes: "1" },
      { path: "file.txt", ustarPrefix: "r/some/prefix", bytes: "2" },
    ]);
    const entries = await collect(archive);
    expect(entries.map((entry) => entry.path)).toEqual([longName, "r/some/prefix/file.txt"]);
  });

  test("skips bodies the caller rejects", async () => {
    const archive = buildTar([
      { path: "r/keep", bytes: "k" },
      { path: "r/skip", bytes: "s".repeat(2000) },
      { path: "r/keep2", bytes: "k2" },
    ]);
    const entries = await collect(archive, 300, (path) => !path.endsWith("skip"));
    expect(entries.map((entry) => [entry.path, entry.bytes === undefined])).toEqual([
      ["r/keep", false],
      ["r/skip", true],
      ["r/keep2", false],
    ]);
    expect(text(entries[2])).toBe("k2");
  });

  test("rejects a bad checksum", async () => {
    const archive = buildTar([{ path: "r/a", bytes: "a" }]);
    archive[0] = 0x5a;
    await expect(collect(archive)).rejects.toBeInstanceOf(TarError);
  });

  test("rejects a truncated body and a missing end marker", async () => {
    const archive = buildTar([{ path: "r/a", bytes: "a".repeat(1000) }]);
    await expect(collect(archive.subarray(0, 700))).rejects.toThrow("truncated");
    const noEnd = buildTar([{ path: "r/a", bytes: "a" }], { end: false });
    await expect(collect(noEnd)).rejects.toThrow("end-of-archive");
  });

  test("rejects oversized metadata headers", async () => {
    const header = tarHeader({ path: "PaxHeader", type: "x" }, 2 * 1024 * 1024);
    await expect(collect(header)).rejects.toThrow("too large");
  });

  test("reads past the end marker to the end of the stream, so a late stream error is reported", async () => {
    const archive = buildTar([{ path: "r/a", bytes: "a" }]);
    let delivered = false;
    // Delivers the whole archive, end marker included, and fails only on the next pull,
    // the way DecompressionStream fails when the gzip trailer turns out to be bad.
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (delivered) {
          controller.error(new Error("gzip trailer is corrupt"));
          return;
        }
        delivered = true;
        controller.enqueue(archive);
      },
    });
    const paths: string[] = [];
    const read = async () => {
      for await (const entry of readTar(failing)) paths.push(entry.path);
    };
    await expect(read()).rejects.toThrow("gzip trailer is corrupt");
    expect(paths).toEqual(["r/a"]);
  });

  test("stops cleanly when the caller breaks early", async () => {
    const archive = buildTar([
      { path: "r/a", bytes: "a" },
      { path: "r/b", bytes: "b" },
    ]);
    let cancelled = false;
    const source = chunkedStream(archive, 512);
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const reader = source.getReader();
        const next = await reader.read();
        reader.releaseLock();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const entry of readTar(stream)) {
      expect(entry.path).toBe("r/a");
      break;
    }
    expect(cancelled).toBe(true);
  });
});
