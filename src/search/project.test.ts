import { expect, test } from "bun:test";
import { BATCH_SIZE, MAX_MATCHES, matchInPage, searchProject, type FileMatches } from "./project";
import { createWorkerMatcher } from "./worker-matcher";
import type { SearchQuery } from "./text";

const encoder = new TextEncoder();

function fakeFiles(contents: Record<string, string | Uint8Array>, delays: Record<string, number> = {}) {
  return {
    list: async () => Object.keys(contents),
    async readBytes(path: string) {
      await new Promise((resolve) => setTimeout(resolve, delays[path] ?? 0));
      const content = contents[path];
      return typeof content === "string" ? encoder.encode(content) : content;
    },
  };
}

const query = (text: string): SearchQuery => ({ text, caseSensitive: false, wholeWord: false, regex: false });

async function run(files: ReturnType<typeof fakeFiles>, text: string, include = "", exclude = "") {
  const found: FileMatches[] = [];
  const summary = await searchProject(files, {
    query: query(text),
    include,
    exclude,
    signal: new AbortController().signal,
    onFile: (result) => found.push(result),
  });
  return { found, summary };
}

test("results stream in path order even when reads finish out of order", async () => {
  const files = fakeFiles({ "b.ts": "hit", "a.ts": "hit\nhit", "c.ts": "miss" }, { "a.ts": 20 });
  const { found, summary } = await run(files, "hit");
  expect(found.map((result) => [result.path, result.matches.length])).toEqual([
    ["a.ts", 2],
    ["b.ts", 1],
  ]);
  expect(summary).toEqual({ kind: "done", files: 2, matches: 3, truncated: false });
});

test("include and exclude globs narrow the files, and binary files are skipped", async () => {
  const files = fakeFiles({
    "src/a.ts": "hit",
    "src/a.css": "hit",
    "dist/a.ts": "hit",
    "image.png": new Uint8Array([0x68, 0x69, 0x74, 0]),
  });
  expect((await run(files, "hit", "*.ts", "dist")).found.map((result) => result.path)).toEqual(["src/a.ts"]);
  expect((await run(files, "hit")).found.map((result) => result.path)).not.toContain("image.png");
});

test("an invalid regular expression is reported without reading files", async () => {
  const files = fakeFiles({ "a.ts": "x" });
  const summary = await searchProject(files, {
    query: { ...query("("), regex: true },
    include: "",
    exclude: "",
    signal: new AbortController().signal,
    onFile: () => {},
  });
  expect(summary.kind).toBe("invalid");
});

test("an aborted search stops delivering and says so", async () => {
  const files = fakeFiles({ "a.ts": "hit", "b.ts": "hit" }, { "a.ts": 30, "b.ts": 30 });
  const lifetime = new AbortController();
  const found: FileMatches[] = [];
  const running = searchProject(files, {
    query: query("hit"),
    include: "",
    exclude: "",
    signal: lifetime.signal,
    onFile: (result) => found.push(result),
  });
  lifetime.abort();
  expect(await running).toEqual({ kind: "aborted" });
  expect(found).toEqual([]);
});

test("the match cap truncates the results", async () => {
  const files = fakeFiles({ "a.txt": "x\n".repeat(MAX_MATCHES + 10) });
  const { found, summary } = await run(files, "x");
  expect(found[0]?.matches).toHaveLength(MAX_MATCHES);
  expect(summary).toEqual({ kind: "done", files: 1, matches: MAX_MATCHES, truncated: true });
});

test("reads stay one batch ahead of delivery when an early file is slow", async () => {
  const gate = Promise.withResolvers<void>();
  const names = Array.from({ length: 200 }, (_, index) => `f${String(index).padStart(3, "0")}.txt`);
  let reads = 0;
  const files = {
    list: async () => names,
    async readBytes(path: string) {
      reads += 1;
      if (path === "f000.txt") await gate.promise;
      return encoder.encode("hit");
    },
  };
  const running = searchProject(files, {
    query: query("hit"),
    include: "",
    exclude: "",
    signal: new AbortController().signal,
    onFile: () => {},
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(reads).toBeLessThanOrEqual(BATCH_SIZE);
  gate.resolve();
  expect(await running).toEqual({ kind: "done", files: 200, matches: 200, truncated: false });
});

test("cancelling stops a regular expression that backtracks for ever, without freezing the caller", async () => {
  const lifetime = new AbortController();
  const matcher = createWorkerMatcher(lifetime.signal);
  const files = fakeFiles({ "slow.txt": `${"a".repeat(40)}!` });
  const running = searchProject(files, {
    query: { ...query("(a+)+$"), regex: true },
    include: "",
    exclude: "",
    signal: lifetime.signal,
    match: matcher.match,
    onFile: () => {},
  });
  // This timer only fires if the page thread is free while the expression runs.
  await new Promise((resolve) => setTimeout(resolve, 100));
  lifetime.abort();
  expect(await running).toEqual({ kind: "aborted" });
});

test("the worker matcher finds what the in-page matcher finds", async () => {
  const lifetime = new AbortController();
  const matcher = createWorkerMatcher(lifetime.signal);
  const bytes = encoder.encode("one needle\ntwo needle\n");
  const expected = await matchInPage(bytes, query("needle"), 10);
  expect(await matcher.match(bytes, query("needle"), 10)).toEqual(expected);
  matcher.dispose();
});

/** A worker that fails as it starts, like a worker script that cannot load. */
class FailingWorker extends EventTarget {
  constructor() {
    super();
    queueMicrotask(() => this.dispatchEvent(new Event("error")));
  }
  postMessage(): void {}
  terminate(): void {}
}

test("a search worker that fails to start ends the search with an error instead of hanging", async () => {
  const matcher = createWorkerMatcher(new AbortController().signal, () => new FailingWorker());
  // The list arrives after the worker already failed, as with a slow FileService.
  const files = {
    list: async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return ["a.txt", "b.txt"];
    },
    readBytes: async () => encoder.encode("hit"),
  };
  const summary = await searchProject(files, {
    query: query("hit"),
    include: "",
    exclude: "",
    signal: new AbortController().signal,
    match: matcher.match,
    onFile: () => {},
  });
  expect(summary.kind).toBe("failed");
});

test("a worker that fails with matches pending ends the search instead of reporting no matches", async () => {
  let worker: FailingLater | undefined;
  class FailingLater extends EventTarget {
    postMessage(): void {
      // eslint-disable-next-line typescript/no-this-alias -- the test fails the worker once a match is waiting
      worker = this;
    }
    terminate(): void {}
  }
  const matcher = createWorkerMatcher(new AbortController().signal, () => new FailingLater());
  const running = searchProject(fakeFiles({ "a.txt": "hit" }), {
    query: query("hit"),
    include: "",
    exclude: "",
    signal: new AbortController().signal,
    match: matcher.match,
    onFile: () => {},
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  worker?.dispatchEvent(new Event("error"));
  expect((await running).kind).toBe("failed");
});
