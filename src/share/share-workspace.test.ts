import { afterEach, describe, expect, test } from "bun:test";
import { serializeMeta, WORKSPACE_META_PATH } from "../workspace/metadata";
import { textEncoder } from "../lib/bytes";
import type { FileEntry } from "../lib/fs/types";
import {
  createShareLink,
  prepareShare,
  restoreShare,
  sessionShareSource,
  snapshotWorkspace,
  type ShareSource,
} from "./share-workspace";
import { BLANK_TEMPLATE, registerTemplateFiles } from "./templates";

const decoder = new TextDecoder();
const entry = (path: string, text: string): FileEntry => ({ path, bytes: textEncoder.encode(text) });

/** A share source over project files, with the template its metadata names. */
function workspace(files: Record<string, string>, template?: string): ShareSource {
  const bytes = new Map(Object.entries(files).map(([path, text]) => [path, textEncoder.encode(text)]));
  return {
    files: { list: async () => Array.from(bytes.keys()), readBytes: async (path) => bytes.get(path) },
    template: async () => template,
  };
}

/** A share source whose file reads behave as given. */
function source(files: ShareSource["files"]): ShareSource {
  return { files, template: async () => undefined };
}

const TEMPLATE = [entry("index.html", "<h1>x</h1>"), entry("src/main.ts", "start")];

afterEach(() => registerTemplateFiles(() => undefined));

describe("prepareShare, what the Share control shows", () => {
  test("a failed listing or read becomes a message, never a rejection", async () => {
    const failingList = source({
      list: () => Promise.reject(new Error("listing failed")),
      readBytes: async () => undefined,
    });
    expect(await prepareShare(failingList, "https://sprockt.dev")).toEqual({
      kind: "error",
      message: "Could not create share link: listing failed",
    });
    const failingRead = source({
      list: async () => ["a.txt"],
      readBytes: () => Promise.reject(new Error("read failed")),
    });
    expect(await prepareShare(failingRead, "https://sprockt.dev")).toMatchObject({ kind: "error" });
    const failingMeta: ShareSource = {
      files: { list: async () => [], readBytes: async () => undefined },
      template: () => Promise.reject(new Error("metadata unreadable")),
    };
    expect(await prepareShare(failingMeta, "https://sprockt.dev")).toMatchObject({ kind: "error" });
  });

  test("a workspace that fits gives a link, one that does not says it is too big", async () => {
    expect(await prepareShare(workspace({ "a.txt": "a" }), "https://sprockt.dev")).toMatchObject({
      kind: "link",
    });
    const random = new Uint8Array(64 * 1024);
    crypto.getRandomValues(random);
    const big = source({ list: async () => ["big.bin"], readBytes: async () => random });
    expect(await prepareShare(big, "https://sprockt.dev")).toEqual({
      kind: "error",
      message: "This workspace is too large for a share link. Download it as a ZIP instead.",
    });
  });
});

describe("share links from a workspace", () => {
  test("without a known template, the link carries every project file (a .sprockt folder is dropped)", async () => {
    const snapshot = await snapshotWorkspace(workspace({ "a.txt": "a", ".sprockt/stray.json": "{}" }));
    expect(snapshot.templateId).toBe(BLANK_TEMPLATE);
    expect(snapshot.files.map((file) => file.path)).toEqual(["a.txt"]);
  });

  test("an open workspace's template comes from the metadata on the filesystem root", async () => {
    const meta = serializeMeta({ name: "x", template: "vanilla", created: "" });
    const session = {
      files: { list: async () => [], readBytes: async () => undefined },
      runtime: {
        filesystem: {
          readFile: async (path: string) =>
            path === WORKSPACE_META_PATH ? textEncoder.encode(meta) : undefined,
        },
      },
    } as never;
    expect(await sessionShareSource(session).template()).toBe("vanilla");
  });

  test("with a registered template, the link carries only the changes and restores the whole set", async () => {
    registerTemplateFiles((id) => (id === "vanilla" ? TEMPLATE : undefined));
    const files = workspace(
      { "index.html": "<h1>x</h1>", "src/main.ts": "changed", "src/new.ts": "added" },
      "vanilla",
    );
    const snapshot = await snapshotWorkspace(files);
    expect(snapshot.templateId).toBe("vanilla");
    expect(snapshot.files.map((file) => file.path)).toEqual(["src/main.ts", "src/new.ts"]);

    const link = await createShareLink(files, "https://sprockt.dev");
    if (!link.ok) throw new Error("expected a link");
    expect(link.url).toMatch(/^https:\/\/sprockt\.dev\/s#share=[A-Za-z0-9_-]+$/);
    const restored = await restoreShare(new URL(link.url).hash);
    if (!restored.ok) throw new Error("expected the link to restore");
    expect(restored.template).toBe("vanilla");
    const texts = Object.fromEntries(
      Object.entries(restored.files).map(([path, bytes]) => [path, decoder.decode(bytes)]),
    );
    expect(texts).toEqual({ "index.html": "<h1>x</h1>", "src/main.ts": "changed", "src/new.ts": "added" });
  });

  test("a link whose template this build does not know does not restore", async () => {
    registerTemplateFiles((id) => (id === "vanilla" ? TEMPLATE : undefined));
    const link = await createShareLink(workspace({ "a.txt": "a" }, "vanilla"), "https://sprockt.dev");
    if (!link.ok) throw new Error("expected a link");
    registerTemplateFiles(() => undefined);
    expect(await restoreShare(new URL(link.url).hash)).toEqual({ ok: false });
    expect(await restoreShare("#share=broken")).toEqual({ ok: false });
  });

  test("a workspace too big for a link says so", async () => {
    const random = new Uint8Array(64 * 1024);
    crypto.getRandomValues(random);
    const big = source({ list: async () => ["big.bin"], readBytes: async () => random });
    expect(await createShareLink(big, "https://sprockt.dev")).toMatchObject({ ok: false, reason: "too-big" });
  });
});
