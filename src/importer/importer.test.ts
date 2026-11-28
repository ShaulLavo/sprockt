import { describe, expect, test } from "bun:test";
import { textEncoder } from "../lib/bytes";
import { COPY } from "./copy";
import { GitHubImportError, type GitHubErrorCode } from "./github/errors";
import { formatSize, formatWait, importErrorMessage, isStorageFull } from "./messages";
import { isMetaPath, parseMeta, serializeMeta, type WorkspaceMeta } from "../workspace/metadata";
import { detectFromEntries, fileRecord, planFrom, sourceFromRoute } from "./plan";

const file = (path: string, text: string) => ({ path, bytes: textEncoder.encode(text) });

describe("import error messages", () => {
  test.each<[GitHubErrorCode, string]>([
    ["not-found", COPY.errors.repoNotFound],
    ["private", COPY.errors.privateRepo],
    ["too-large", COPY.errors.repoTooLarge],
    ["too-many-files", COPY.errors.repoTooManyFiles],
    ["subdir-not-found", COPY.errors.subdirNotFound],
    ["rate-limited", COPY.errors.githubRateLimitUnknown],
  ])("%s shows the copy deck's sentence", (code, message) => {
    expect(importErrorMessage(new GitHubImportError(code, "proxy text"))).toBe(message);
  });

  test("a rate limit with a retry time says how long to wait", () => {
    expect(importErrorMessage(new GitHubImportError("rate-limited", "x", 45))).toBe(
      "GitHub rate limit reached. Try again in 45 seconds.",
    );
    expect(importErrorMessage(new GitHubImportError("rate-limited", "x", 61))).toBe(
      "GitHub rate limit reached. Try again in 2 minutes.",
    );
  });

  test("unexpected errors keep their message", () => {
    expect(importErrorMessage(new Error("boom"))).toBe("Import failed: boom");
  });

  test("waits and sizes", () => {
    expect(formatWait(0.2)).toBe("1 second");
    expect(formatWait(60)).toBe("1 minute");
    expect(formatWait(600)).toBe("10 minutes");
    expect(formatSize(1536)).toBe("1.5 KiB");
    expect(formatSize(5 * 1024 * 1024)).toBe("5.0 MiB");
  });
});

describe("storage-full errors, in every shape the pinned Waffle reports them", () => {
  // What waffle/browser/shared-fs.ts builds from a worker's quota failure.
  const workerError = Object.assign(new Error("Filesystem worker failed: QuotaExceededError"), {
    name: "QuotaExceededError",
  });
  const codeOnly = Object.assign(new Error("Filesystem worker failed: write"), { code: "ENOSPC" });
  // A FilesystemError carries the WASI errno; 51 is ENOSPC.
  const enospc = Object.assign(new Error("filesystem errno 51"), { errno: 51 });
  const messageOnly = new Error("Filesystem worker failed: QuotaExceededError");
  const wrapped = new Error("flush failed", { cause: enospc });

  test.each([
    ["a DOMException", new DOMException("full", "QuotaExceededError")],
    ["a worker error named QuotaExceededError", workerError],
    ["a worker error with code ENOSPC", codeOnly],
    ["a FilesystemError with errno 51", enospc],
    ["a worker error that only says so in its message", messageOnly],
    ["a wrapped cause", wrapped],
  ])("%s shows the storage-full message", (_, error) => {
    expect(isStorageFull(error)).toBe(true);
    expect(importErrorMessage(error)).toBe(COPY.errors.storageFull);
  });

  test("other errors are not storage-full", () => {
    expect(isStorageFull(new Error("Filesystem worker failed: EIO"))).toBe(false);
    expect(isStorageFull(Object.assign(new Error("x"), { errno: 29 }))).toBe(false);
    expect(isStorageFull("QuotaExceededError")).toBe(false);
  });
});

describe("import plan", () => {
  test("rebuilds every ref and path segment from the route", () => {
    expect(sourceFromRoute({ kind: "github", owner: "a", repo: "b" }).refAndPath).toEqual([]);
    const route = { kind: "github", owner: "a", repo: "b", branch: "feature/x", subdir: "apps/web" } as const;
    expect(sourceFromRoute(route)).toEqual({
      owner: "a",
      repo: "b",
      refAndPath: ["feature", "x", "apps", "web"],
      target: "tree",
    });
  });

  test("drops an imported .sprockt folder, or a file of that name, and detects the dev command", () => {
    const files = [
      file("package.json", JSON.stringify({ scripts: { dev: "vite" }, devDependencies: { vite: "7" } })),
      file(".sprockt/workspace.json", "{}"),
      file(".sprockt", "a file in the way"),
      file(".sprocktrc", "kept"),
      file("src/main.ts", ""),
    ];
    expect(Object.keys(fileRecord(files))).toEqual(["package.json", ".sprocktrc", "src/main.ts"]);
    expect(isMetaPath(".sprockt")).toBe(true);
    expect(planFrom(detectFromEntries(files))).toEqual({
      install: { command: "bun", args: ["install"] },
      dev: { command: "bun", args: ["run", "dev"] },
      port: 5173,
    });
  });
});

describe("workspace metadata", () => {
  test("round-trips and refuses anything without a name", () => {
    const meta: WorkspaceMeta = {
      name: "demo",
      created: "2026-11-25T00:00:00.000Z",
      source: { kind: "github", owner: "a", repo: "demo", ref: "main", subdir: "" },
    };
    expect(parseMeta(serializeMeta(meta))).toEqual(meta);
    expect(parseMeta(undefined)).toBeUndefined();
    expect(parseMeta("[]")).toBeUndefined();
    expect(parseMeta("{")).toBeUndefined();
    expect(parseMeta('{"name": 3}')).toBeUndefined();
  });
});
