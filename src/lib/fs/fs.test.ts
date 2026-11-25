import { describe, expect, test } from "bun:test";
import { textEncoder } from "../bytes.ts";
import { collectFiles, writeFiles } from "./entries.ts";
import { MemoryFs } from "./memory.ts";
import { normalizePath } from "./path.ts";

describe("normalizePath", () => {
  test.each([
    ["a/b", "a/b"],
    ["/a//b/", "a/b"],
    ["./a/./b", "a/b"],
    ["", ""],
    ["..", undefined],
    ["a/../b", undefined],
    ["a\\b", undefined],
    ["a\0b", undefined],
  ])("%p -> %p", (input, expected) => {
    expect(normalizePath(input)).toBe(expected);
  });
});

describe("MemoryFs with writeFiles and collectFiles", () => {
  test("writes nested entries and reads them back sorted, with modes", async () => {
    const fs = new MemoryFs();
    await writeFiles(
      fs,
      [
        { path: "src/z.ts", bytes: textEncoder.encode("z") },
        { path: "run.sh", bytes: textEncoder.encode("#!"), mode: 0o755 },
        { path: "src/deep/a.ts", bytes: textEncoder.encode("a") },
        { path: "node_modules/x/i.js", bytes: textEncoder.encode("x") },
      ],
      "proj",
    );
    expect(await fs.stat("proj/src")).toEqual({ kind: "directory", size: 0, mode: 0o755 });
    expect(await fs.stat("proj/run.sh")).toEqual({ kind: "file", size: 2, mode: 0o755 });
    expect(await fs.stat("proj/missing")).toBeUndefined();
    const names = (await fs.readdir("proj")).map((entry) => `${entry.kind}:${entry.name}`).sort();
    expect(names).toEqual(["directory:node_modules", "directory:src", "file:run.sh"]);
    const files = await collectFiles(fs, "proj");
    expect(files.map((entry) => [entry.path, entry.mode])).toEqual([
      ["run.sh", 0o755],
      ["src/deep/a.ts", 0o644],
      ["src/z.ts", 0o644],
    ]);
    expect((await collectFiles(fs, "proj", { excludeDirs: [] })).length).toBe(4);
  });

  test("refuses writes without a parent and paths outside the root", async () => {
    const fs = new MemoryFs();
    await expect(fs.writeFile("a/b.txt", new Uint8Array())).rejects.toThrow("ENOENT");
    await expect(fs.readFile("../x")).rejects.toThrow("EINVAL");
    await fs.writeFile("f", new Uint8Array());
    await expect(fs.mkdir("f/g")).rejects.toThrow("EEXIST");
  });
});
