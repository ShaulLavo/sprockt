import { describe, expect, test } from "bun:test";
import type { FileEntry } from "../lib/fs/types.ts";
import { compressBytes, textEncoder, toBase64Url } from "../lib/bytes.ts";
import {
  applySnapshot,
  decodeShareFragment,
  diffSnapshot,
  encodeShareFragment,
  forkFromGitHubUrl,
  type ShareSnapshot,
} from "./share.ts";

const file = (path: string, content: string | Uint8Array, mode?: number): FileEntry => ({
  path,
  bytes: typeof content === "string" ? textEncoder.encode(content) : content,
  ...(mode === undefined ? {} : { mode }),
});

/** A share fragment holding arbitrary text, to feed the decoder hand-made payloads. */
async function deflatedLink(text: string): Promise<string> {
  return `share=${toBase64Url(await compressBytes(textEncoder.encode(text), "deflate-raw"))}`;
}

async function roundTrip(snapshot: ShareSnapshot): Promise<ShareSnapshot> {
  const encoded = await encodeShareFragment(snapshot);
  if (!encoded.ok) throw new Error("too big");
  const decoded = await decodeShareFragment(`https://sprockt.dev/#${encoded.fragment}`);
  if (!decoded.ok) throw new Error(decoded.error);
  return decoded.snapshot;
}

describe("share links", () => {
  test("round-trip text, binary, modes and deletions", async () => {
    const snapshot: ShareSnapshot = {
      templateId: "vite-react",
      files: [
        file("src/App.tsx", "export default () => <h1>héllo 🌍</h1>\n"),
        file("public/icon.bin", new Uint8Array([0, 255, 128, 7, 0xc3])),
        file("run.sh", "#!/bin/sh\n", 0o755),
      ],
      deleted: ["src/App.css"],
    };
    const decoded = await roundTrip(snapshot);
    expect(decoded.templateId).toBe("vite-react");
    expect(decoded.deleted).toEqual(["src/App.css"]);
    expect(decoded.files.map((entry) => [entry.path, entry.mode])).toEqual([
      ["src/App.tsx", 0o644],
      ["public/icon.bin", 0o644],
      ["run.sh", 0o755],
    ]);
    snapshot.files.forEach((entry, index) => expect(decoded.files[index]?.bytes).toEqual(entry.bytes));
  });

  test("the fragment is URL safe and compressed", async () => {
    const encoded = await encodeShareFragment({
      templateId: "t",
      files: [file("a.txt", "repeat ".repeat(2000))],
      deleted: [],
    });
    if (!encoded.ok) throw new Error("too big");
    expect(encoded.fragment).toMatch(/^share=[A-Za-z0-9_-]+$/);
    expect(encoded.fragment.length).toBeLessThan(200);
  });

  test("reports a snapshot that is too big for a link", async () => {
    const big = new Uint8Array(40_000);
    crypto.getRandomValues(big);
    const result = await encodeShareFragment({ templateId: "t", files: [file("big.bin", big)], deleted: [] });
    if (result.ok || result.reason !== "too-big") throw new Error("expected too-big");
    expect(result.length).toBeGreaterThan(result.maxLength);
    const small = await encodeShareFragment(
      { templateId: "t", files: [file("a", "abc")], deleted: [] },
      { maxLength: 10 },
    );
    expect(small.ok).toBe(false);
  });

  test("accepts the fragment with or without # and alongside other parameters", async () => {
    const encoded = await encodeShareFragment({ templateId: "t", files: [file("a", "1")], deleted: [] });
    if (!encoded.ok) throw new Error("too big");
    const inputs = [encoded.fragment, `#${encoded.fragment}`, `#theme=dark&${encoded.fragment}`];
    const decoded = await Promise.all(inputs.map((input) => decodeShareFragment(input)));
    expect(decoded.map((result) => result.ok)).toEqual([true, true, true]);
  });

  test.each([
    ["#nothing=here"],
    ["#share=***"],
    ["#share=AAAA"],
    ["deflated:not json"],
    [`deflated:${JSON.stringify({ t: 1, f: [] })}`],
    [`deflated:${JSON.stringify({ t: "x", f: [["../escape", "x"]] })}`],
    [`deflated:${JSON.stringify({ t: "x", f: [["a", 5]] })}`],
    [`deflated:${JSON.stringify({ t: "x", f: [], d: ["/../../etc"] })}`],
  ])("rejects the damaged or hostile link %p", async (input) => {
    const link = input.startsWith("deflated:") ? await deflatedLink(input.slice("deflated:".length)) : input;
    expect((await decodeShareFragment(link)).ok).toBe(false);
  });

  test("restores every file byte for byte, including a UTF-8 BOM, empty files and binary", async () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
    const files = [
      file("bom.txt", new Uint8Array(Array.from(bom).concat(Array.from(textEncoder.encode("héllo\r\n"))))),
      file("only-bom.txt", bom),
      file("empty.txt", ""),
      file("nul.txt", "a\u0000b"),
      file("bin.dat", new Uint8Array([0xff, 0xfe, 0x00, 0x80])),
      file("half-utf8.dat", new Uint8Array([0x61, 0xe2, 0x82])),
      file("emoji 名前.md", "🌍   ﻿ mid-file BOM"),
    ];
    const decoded = await roundTrip({ templateId: "t", files, deleted: [] });
    expect(decoded.files.map((entry) => entry.path)).toEqual(files.map((entry) => entry.path));
    files.forEach((entry, index) => expect(decoded.files[index]?.bytes).toEqual(new Uint8Array(entry.bytes)));
  });

  test("never makes a link the decoder would reject", async () => {
    // 9 MiB of repeated text compresses to a short fragment but decodes past the payload ceiling.
    const huge = file("big.txt", "same line again\n".repeat((9 * 1024 * 1024) / 16));
    const result = await encodeShareFragment({ templateId: "t", files: [huge], deleted: [] });
    expect(result).toMatchObject({ ok: false, reason: "too-big" });
    // A caller-raised maxLength is clamped to what the decoder reads.
    const random = new Uint8Array(1_000_000);
    for (let offset = 0; offset < random.byteLength; offset += 65536)
      crypto.getRandomValues(random.subarray(offset, offset + 65536));
    const clamped = await encodeShareFragment(
      { templateId: "t", files: [file("r.bin", random)], deleted: [] },
      { maxLength: 10 * 1024 * 1024 },
    );
    expect(clamped).toMatchObject({ ok: false, reason: "too-big", maxLength: 1024 * 1024 });
  });

  test.each(["./a.txt", "../a", "/abs", "", "a//b", "a/./b"])(
    "refuses the path %p, which the decoder would not restore unchanged",
    async (path) => {
      const result = await encodeShareFragment({ templateId: "t", files: [file(path, "x")], deleted: [] });
      expect(result).toEqual({ ok: false, reason: "invalid-path", path });
    },
  );

  test("refuses a deleted path that leaves the workspace", async () => {
    const deleted = await encodeShareFragment({ templateId: "t", files: [], deleted: ["../x"] });
    expect(deleted).toEqual({ ok: false, reason: "invalid-path", path: "../x" });
  });

  test.each([
    "null",
    "[]",
    "42",
    '"text"',
    JSON.stringify({ t: "x", f: [], d: "not-an-array" }),
    JSON.stringify({ t: "x", f: [], d: [1] }),
    JSON.stringify({ t: "x", f: {} }),
    JSON.stringify({ t: "x", f: [null] }),
    JSON.stringify({ t: "x", f: [["a"]] }),
    JSON.stringify({ t: "x", f: [["a", "b", 2]] }),
    JSON.stringify({ t: "x", f: [["a", "b", 0, -1]] }),
    JSON.stringify({ t: "x", f: [["a", "b", 0, 1.5]] }),
    JSON.stringify({ t: "x", f: [["a", "b", 0, 0o644, "extra"]] }),
    JSON.stringify({ t: "x", f: [["a", "***", 1]] }),
  ])("returns a damaged result, never throws, for the JSON %s", async (shape) => {
    expect(await decodeShareFragment(await deflatedLink(shape))).toEqual({
      ok: false,
      error: "This share link is damaged.",
    });
  });

  test("checks the encoded size before decoding anything", async () => {
    const oversized = `#share=${"A".repeat(1024 * 1024 + 10)}`;
    expect(await decodeShareFragment(oversized)).toEqual({
      ok: false,
      error: "This share link holds too much data.",
    });
    expect(await decodeShareFragment("x".repeat(3 * 1024 * 1024))).toEqual({
      ok: false,
      error: "This share link holds too much data.",
    });
  });

  test("refuses a decompression bomb", async () => {
    const bomb = await compressBytes(new Uint8Array(20 * 1024 * 1024), "deflate-raw");
    const decoded = await decodeShareFragment(`share=${toBase64Url(bomb)}`);
    expect(decoded).toEqual({ ok: false, error: "This share link holds too much data." });
  });
});

describe("diffSnapshot and applySnapshot", () => {
  const template = [file("index.html", "<h1>x</h1>"), file("src/a.ts", "a"), file("src/b.ts", "b")];

  test("records changed, added and deleted files, and applies them back", () => {
    const current = [
      file("index.html", "<h1>x</h1>"),
      file("src/a.ts", "a2"),
      file("src/c.ts", "c"),
      file("src/b.ts", "b", 0o755),
    ];
    const snapshot = diffSnapshot("tpl", template, current);
    expect(snapshot.files.map((entry) => entry.path)).toEqual(["src/a.ts", "src/c.ts", "src/b.ts"]);
    expect(snapshot.deleted).toEqual([]);
    const applied = applySnapshot(template, snapshot);
    expect(applied.map((entry) => entry.path)).toEqual(["index.html", "src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  test("an unchanged workspace shares only its template", async () => {
    const snapshot = diffSnapshot("tpl", template, template);
    expect(snapshot).toEqual({ templateId: "tpl", files: [], deleted: [] });
    const withDeletion = diffSnapshot("tpl", template, template.slice(1));
    expect(withDeletion.deleted).toEqual(["index.html"]);
    expect(applySnapshot(template, await roundTrip(withDeletion)).map((entry) => entry.path)).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
  });
});

describe("forkFromGitHubUrl", () => {
  test("builds an import link", () => {
    expect(forkFromGitHubUrl("https://sprockt.dev", "vitejs", "vite")).toBe(
      "https://sprockt.dev/github/vitejs/vite",
    );
    expect(forkFromGitHubUrl("https://sprockt.dev/", "vitejs", "vite", "main", "packages/create-vite")).toBe(
      "https://sprockt.dev/github/vitejs/vite/tree/main/packages/create-vite",
    );
  });
});
