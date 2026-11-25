import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTar, chunkedStream, paxBody, type TarFixtureEntry } from "./tar-writer.ts";
import { GitHubImportError, type GitHubErrorCode } from "./errors.ts";
import { importGitHubRepo, type ImportProgress } from "./import.ts";
import { parseGitHubSource, type GitHubSource } from "./source.ts";

function source(input: string): GitHubSource {
  const result = parseGitHubSource(input);
  if (!result.ok) throw new Error(result.error);
  return result.source;
}

const SHA = "0123456789abcdef0123456789abcdef01234567";

function repoArchive(extra: readonly TarFixtureEntry[] = []): Uint8Array {
  const base: TarFixtureEntry[] = [
    { path: "pax_global_header", type: "g", bytes: paxBody({ comment: SHA }) },
    { path: "demo-0123456/", type: "5", mode: 0o775 },
    { path: "demo-0123456/package.json", bytes: '{"name":"demo"}', mode: 0o664 },
    { path: "demo-0123456/bin/run", bytes: "#!/bin/sh", mode: 0o775 },
    { path: "demo-0123456/apps/web/index.html", bytes: "<h1>web</h1>", mode: 0o664 },
    { path: "demo-0123456/apps/web/src/main.ts", bytes: "console.log(1)", mode: 0o664 },
    { path: "demo-0123456/apps/webby/x.ts", bytes: "no", mode: 0o664 },
    { path: "demo-0123456/link", type: "2", linkTarget: "package.json" },
  ];
  return Bun.gzipSync(buildTar(base.concat(extra)));
}

interface Route {
  readonly status?: number;
  readonly body?: Uint8Array | string | object;
  readonly headers?: Record<string, string>;
}

function mockFetch(routes: Record<string, Route>, calls: string[] = []) {
  return async (input: string): Promise<Response> => {
    calls.push(input);
    const route = routes[input];
    if (!route)
      return Response.json({ error: "not-found", message: `no mock for ${input}` }, { status: 404 });
    const body = route.body;
    if (body instanceof Uint8Array) {
      return new Response(chunkedStream(body, 1000), { status: route.status ?? 200, headers: route.headers });
    }
    if (typeof body === "object")
      return Response.json(body, { status: route.status ?? 200, headers: route.headers });
    return new Response(body ?? null, { status: route.status ?? 200, headers: route.headers });
  };
}

async function failingFetch(): Promise<Response> {
  throw new TypeError("Failed to fetch");
}

async function importError(promise: Promise<unknown>): Promise<GitHubImportError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GitHubImportError) return error;
    throw error;
  }
  throw new Error("expected the import to fail");
}

describe("importGitHubRepo", () => {
  test("reports progress: resolving first, then growing download totals", async () => {
    const fetch = mockFetch({ "/api/github/archive/acme/demo/main": { body: repoArchive() } });
    const stages: ImportProgress[] = [];
    await importGitHubRepo(source("/github/acme/demo/tree/main"), {
      fetch,
      onProgress: (p) => stages.push(p),
    });
    expect(stages[0]).toEqual({ stage: "resolving" });
    const downloads = stages.flatMap((p) => (p.stage === "downloading" ? [p.bytes] : []));
    expect(downloads.length).toBeGreaterThan(0);
    expect(downloads).toEqual(downloads.toSorted((a, b) => a - b));
    expect(downloads.at(-1)).toBe(repoArchive().byteLength);
  });

  test("resolves the default branch and unpacks the whole repository", async () => {
    const calls: string[] = [];
    const fetch = mockFetch(
      {
        "/api/github/repo/acme/demo": {
          body: { owner: "acme", repo: "demo", defaultBranch: "trunk", sizeKiB: 1 },
        },
        "/api/github/archive/acme/demo/trunk": { body: repoArchive() },
      },
      calls,
    );
    const result = await importGitHubRepo(source("https://github.com/acme/demo"), { fetch });
    expect(calls).toEqual(["/api/github/repo/acme/demo", "/api/github/archive/acme/demo/trunk"]);
    expect(result.ref).toBe("trunk");
    expect(result.commit).toBe(SHA);
    expect(result.skipped).toBe(1);
    expect(result.files.map((file) => [file.path, file.mode])).toEqual([
      ["package.json", 0o644],
      ["bin/run", 0o755],
      ["apps/web/index.html", 0o644],
      ["apps/web/src/main.ts", 0o644],
      ["apps/webby/x.ts", 0o644],
    ]);
    expect(new TextDecoder().decode(result.files[0]?.bytes)).toBe('{"name":"demo"}');
  });

  test("keeps only the requested subdirectory, relative to it", async () => {
    const fetch = mockFetch({
      "/api/github/refs/acme/demo/main": { body: { branches: ["main"], tags: [] } },
      "/api/github/archive/acme/demo/refs/heads/main": { body: repoArchive() },
    });
    const result = await importGitHubRepo(source("/github/acme/demo/tree/main/apps/web"), { fetch });
    expect(result.subdir).toBe("apps/web");
    expect(result.files.map((file) => file.path)).toEqual(["index.html", "src/main.ts"]);
  });

  test("resolves where a slashed branch name ends before downloading", async () => {
    const calls: string[] = [];
    const fetch = mockFetch(
      {
        "/api/github/refs/acme/demo/feature": { body: { branches: ["feature/x", "feature-y"], tags: [] } },
        "/api/github/archive/acme/demo/refs/heads/feature/x": { body: repoArchive() },
      },
      calls,
    );
    const result = await importGitHubRepo(source("/github/acme/demo/tree/feature/x/apps/web"), {
      fetch,
      apiBase: "/api/github/",
    });
    expect(calls).toEqual([
      "/api/github/refs/acme/demo/feature",
      "/api/github/archive/acme/demo/refs/heads/feature/x",
    ]);
    expect(result.ref).toBe("feature/x");
    expect(result.files.map((file) => file.path)).toEqual(["index.html", "src/main.ts"]);
  });

  test("a shorter tag does not mask the longer branch", async () => {
    const calls: string[] = [];
    const fetch = mockFetch(
      {
        "/api/github/refs/acme/demo/feature": { body: { branches: ["feature/x"], tags: ["feature"] } },
        "/api/github/archive/acme/demo/refs/heads/feature/x": { body: repoArchive() },
        "/api/github/archive/acme/demo/refs/tags/feature": { body: repoArchive() },
      },
      calls,
    );
    const result = await importGitHubRepo(source("/github/acme/demo/tree/feature/x/apps/web"), { fetch });
    expect(result.ref).toBe("feature/x");
    expect(calls.at(-1)).toBe("/api/github/archive/acme/demo/refs/heads/feature/x");
  });

  test("deep and non-ASCII branch names resolve, with each segment encoded", async () => {
    const calls: string[] = [];
    const fetch = mockFetch(
      {
        "/api/github/refs/acme/demo/teams": {
          body: { branches: ["teams/frontend/release/stable/v1"], tags: [] },
        },
        "/api/github/archive/acme/demo/refs/heads/teams/frontend/release/stable/v1": { body: repoArchive() },
        "/api/github/refs/acme/demo/caf%C3%A9": { body: { branches: ["café/menu"], tags: [] } },
        "/api/github/archive/acme/demo/refs/heads/caf%C3%A9/menu": { body: repoArchive() },
      },
      calls,
    );
    const deep = await importGitHubRepo(
      source("/github/acme/demo/tree/teams/frontend/release/stable/v1/apps/web"),
      {
        fetch,
      },
    );
    expect(deep.ref).toBe("teams/frontend/release/stable/v1");
    expect(deep.subdir).toBe("apps/web");
    const accented = await importGitHubRepo(
      source("https://github.com/acme/demo/tree/caf%C3%A9/menu/apps/web"),
      { fetch },
    );
    expect(accented.ref).toBe("café/menu");
    expect(calls.at(-1)).toBe("/api/github/archive/acme/demo/refs/heads/caf%C3%A9/menu");
  });

  test("branches whose first component is not a valid ref on its own still resolve", async () => {
    const calls: string[] = [];
    const fetch = mockFetch(
      {
        "/api/github/refs/acme/demo/release.": { body: { branches: ["release./stable"], tags: [] } },
        "/api/github/archive/acme/demo/refs/heads/release./stable": { body: repoArchive() },
        "/api/github/refs/acme/demo/%40": { body: { branches: ["@/stable"], tags: [] } },
        "/api/github/archive/acme/demo/refs/heads/%40/stable": { body: repoArchive() },
      },
      calls,
    );
    const dotted = await importGitHubRepo(
      source("https://github.com/acme/demo/tree/release./stable/apps/web"),
      { fetch },
    );
    expect([dotted.ref, dotted.subdir]).toEqual(["release./stable", "apps/web"]);
    expect(dotted.files.map((file) => file.path)).toEqual(["index.html", "src/main.ts"]);
    const at = await importGitHubRepo(source("https://github.com/acme/demo/tree/@/stable/apps/web"), {
      fetch,
    });
    expect([at.ref, at.subdir]).toEqual(["@/stable", "apps/web"]);
    expect(calls.at(-1)).toBe("/api/github/archive/acme/demo/refs/heads/%40/stable");
  });

  test("fully qualified refs/heads and refs/tags links resolve in their own namespace", async () => {
    const calls: string[] = [];
    const fetch = mockFetch(
      {
        "/api/github/refs/acme/demo/main": { body: { branches: ["main"], tags: ["main"] } },
        "/api/github/archive/acme/demo/refs/heads/main": { body: repoArchive() },
        "/api/github/refs/acme/demo/v1": { body: { branches: ["v1"], tags: ["v1"] } },
        "/api/github/archive/acme/demo/refs/tags/v1": { body: repoArchive() },
        "/api/github/archive/acme/demo/refs/tags/v2": { body: repoArchive() },
      },
      calls,
    );
    const branch = await importGitHubRepo(
      source("https://github.com/acme/demo/tree/refs/heads/main/apps/web"),
      { fetch },
    );
    expect([branch.ref, branch.subdir]).toEqual(["main", "apps/web"]);
    expect(calls.slice(-2)).toEqual([
      "/api/github/refs/acme/demo/main",
      "/api/github/archive/acme/demo/refs/heads/main",
    ]);
    const tag = await importGitHubRepo(source("/github/acme/demo/tree/refs/tags/v1/apps/web"), { fetch });
    expect([tag.ref, tag.subdir]).toEqual(["v1", "apps/web"]);
    expect(calls.at(-1)).toBe("/api/github/archive/acme/demo/refs/tags/v1");
    const whole = await importGitHubRepo(source("/github/acme/demo/tree/refs/tags/v2"), { fetch });
    expect(whole.ref).toBe("v2");
    expect(calls.at(-1)).toBe("/api/github/archive/acme/demo/refs/tags/v2");
  });

  test("a qualified branch link does not fall back to a tag of the same name", async () => {
    const fetch = mockFetch({ "/api/github/refs/acme/demo/v1": { body: { branches: [], tags: ["v1"] } } });
    const error = await importError(
      importGitHubRepo(source("/github/acme/demo/tree/refs/heads/v1/src"), { fetch }),
    );
    expect(error.code).toBe("not-found");
  });

  test("an abbreviated commit id followed by a subfolder falls back to the commit", async () => {
    const calls: string[] = [];
    const fetch = mockFetch(
      {
        "/api/github/refs/acme/demo/5e329a286aeb": { body: { branches: [], tags: [] } },
        "/api/github/archive/acme/demo/5e329a286aeb": { body: repoArchive() },
      },
      calls,
    );
    const result = await importGitHubRepo(source("https://github.com/acme/demo/tree/5e329a286aeb/apps/web"), {
      fetch,
    });
    expect([result.ref, result.subdir]).toEqual(["5e329a286aeb", "apps/web"]);
    expect(result.files.map((file) => file.path)).toEqual(["index.html", "src/main.ts"]);
    expect(calls.at(-1)).toBe("/api/github/archive/acme/demo/5e329a286aeb");
  });

  test("reports a link whose ref matches no branch or tag", async () => {
    const fetch = mockFetch({
      "/api/github/refs/acme/demo/nope": { body: { branches: ["nope-not"], tags: [] } },
    });
    const error = await importError(importGitHubRepo(source("/github/acme/demo/tree/nope/src"), { fetch }));
    expect(error.code).toBe("not-found");
    expect(error.message).toContain('"nope/src"');
  });

  test("a single-segment ref or a commit id needs no lookup", async () => {
    const calls: string[] = [];
    const fetch = mockFetch(
      {
        "/api/github/archive/acme/demo/v1.2.0": { body: repoArchive() },
        [`/api/github/archive/acme/demo/${SHA}`]: { body: repoArchive() },
      },
      calls,
    );
    await importGitHubRepo(source("/github/acme/demo/tree/v1.2.0"), { fetch });
    await importGitHubRepo(source(`/github/acme/demo/tree/${SHA}/apps/web`), { fetch });
    expect(calls).toEqual(["/api/github/archive/acme/demo/v1.2.0", `/api/github/archive/acme/demo/${SHA}`]);
  });

  test("reports a missing subdirectory", async () => {
    const fetch = mockFetch({
      "/api/github/refs/acme/demo/main": { body: { branches: ["main"], tags: [] } },
      "/api/github/archive/acme/demo/refs/heads/main": { body: repoArchive() },
    });
    const error = await importError(importGitHubRepo(source("/github/acme/demo/tree/main/nope"), { fetch }));
    expect(error.code).toBe("subdir-not-found");
  });

  test("passes through the proxy's error codes", async () => {
    const fetch = mockFetch({
      "/api/github/repo/acme/demo": {
        status: 429,
        body: { error: "rate-limited", message: "slow down", retryAfter: 30 },
      },
    });
    const error = await importError(importGitHubRepo(source("acme/demo"), { fetch }));
    expect(error.code).toBe("rate-limited");
    expect(error.retryAfter).toBe(30);
  });

  test.each<[number, GitHubErrorCode]>([
    [404, "not-found"],
    [429, "rate-limited"],
    [413, "too-large"],
    [500, "upstream"],
  ])("maps a bare HTTP %d (not the proxy's JSON) to %s", async (status, code) => {
    const fetch = mockFetch({ "/api/github/archive/acme/demo/main": { status, body: "oops" } });
    const error = await importError(importGitHubRepo(source("/github/acme/demo/tree/main"), { fetch }));
    expect(error.code).toBe(code);
  });

  test("reports a network failure", async () => {
    const error = await importError(
      importGitHubRepo(source("/github/a/b/tree/main"), { fetch: failingFetch }),
    );
    expect(error.code).toBe("network");
  });

  test("enforces the archive, unpacked size and file count limits", async () => {
    const fetch = mockFetch({ "/api/github/archive/acme/demo/main": { body: repoArchive() } });
    const src = source("/github/acme/demo/tree/main");
    expect((await importError(importGitHubRepo(src, { fetch, limits: { maxArchiveBytes: 50 } }))).code).toBe(
      "too-large",
    );
    expect((await importError(importGitHubRepo(src, { fetch, limits: { maxTotalBytes: 20 } }))).code).toBe(
      "too-large",
    );
    expect((await importError(importGitHubRepo(src, { fetch, limits: { maxFiles: 2 } }))).code).toBe(
      "too-many-files",
    );
  });

  test("refuses a declared archive size over the limit before reading", async () => {
    const fetch = mockFetch({
      "/api/github/archive/acme/demo/main": {
        body: repoArchive(),
        headers: { "content-length": "999999999" },
      },
    });
    const error = await importError(importGitHubRepo(source("/github/acme/demo/tree/main"), { fetch }));
    expect(error.code).toBe("too-large");
  });

  test("reports damaged archives", async () => {
    const notGzip = mockFetch({ "/api/github/archive/a/b/main": { body: new Uint8Array([1, 2, 3, 4]) } });
    expect(
      (await importError(importGitHubRepo(source("/github/a/b/tree/main"), { fetch: notGzip }))).code,
    ).toBe("bad-archive");
    const truncated = Bun.gzipSync(buildTar([{ path: "r/a", bytes: "a".repeat(2000) }]).subarray(0, 900));
    const fetch = mockFetch({ "/api/github/archive/a/b/main": { body: truncated } });
    expect((await importError(importGitHubRepo(source("/github/a/b/tree/main"), { fetch }))).code).toBe(
      "bad-archive",
    );
  });

  test("drops entries that would escape the workspace", async () => {
    const archive = repoArchive([{ path: "demo-0123456/../../etc/passwd", bytes: "x" }]);
    const fetch = mockFetch({ "/api/github/archive/acme/demo/main": { body: archive } });
    const result = await importGitHubRepo(source("/github/acme/demo/tree/main"), { fetch });
    expect(result.files.some((file) => file.path.includes("passwd"))).toBe(false);
  });

  test("rejects absolute archive paths and anything outside the archive's top-level folder", async () => {
    const archive = repoArchive([
      { path: "/demo-0123456/absolute.txt", bytes: "x" },
      { path: "/etc/passwd", bytes: "x" },
      { path: "other-root/stray.txt", bytes: "x" },
    ]);
    const fetch = mockFetch({ "/api/github/archive/acme/demo/main": { body: archive } });
    const result = await importGitHubRepo(source("/github/acme/demo/tree/main"), { fetch });
    const paths = result.files.map((file) => file.path);
    expect(paths).not.toContain("absolute.txt");
    expect(paths.some((path) => path.includes("passwd") || path.includes("stray"))).toBe(false);
    expect(paths).toContain("package.json");
  });

  test("counts skipped files against the scanned-bytes budget", async () => {
    const outside = new Uint8Array(300_000).map((_, index) => (index * 7919) % 256);
    const archive = repoArchive([{ path: "demo-0123456/assets/huge.bin", bytes: outside }]);
    const fetch = mockFetch({
      "/api/github/refs/acme/demo/main": { body: { branches: ["main"], tags: [] } },
      "/api/github/archive/acme/demo/refs/heads/main": { body: archive },
    });
    const sub = source("/github/acme/demo/tree/main/apps/web");
    const ok = await importGitHubRepo(sub, { fetch });
    expect(ok.files).toHaveLength(2);
    const error = await importError(importGitHubRepo(sub, { fetch, limits: { maxScannedBytes: 100_000 } }));
    expect(error.code).toBe("too-large");
    expect(error.message).toContain("unpacks to more than");
  });

  test("fails when the gzip trailer is missing or wrong, even after the tar end marker", async () => {
    const good = repoArchive();
    const truncated = good.slice(0, good.byteLength - 4);
    const badCrc = good.slice();
    badCrc[badCrc.byteLength - 8] = (badCrc[badCrc.byteLength - 8] ?? 0) ^ 0xff;
    const errors = await Promise.all(
      [truncated, badCrc].map((body) => {
        const fetch = mockFetch({ "/api/github/archive/acme/demo/main": { body } });
        return importError(importGitHubRepo(source("/github/acme/demo/tree/main"), { fetch }));
      }),
    );
    expect(errors.map((error) => error.code)).toEqual(["bad-archive", "bad-archive"]);
  });
});

describe("importGitHubRepo with a real git archive", () => {
  const dir = mkdtempSync(join(tmpdir(), "sprockt-git-archive-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("unpacks what `git archive` produces, like codeload does", async () => {
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", "-C", dir].concat(args), {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
        },
      });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return result.stdout;
    };
    git("init", "-q");
    const longDir = `${"nested-directory-name/".repeat(6)}leaf`;
    mkdirSync(join(dir, longDir), { recursive: true });
    mkdirSync(join(dir, "pkg", "src"), { recursive: true });
    writeFileSync(join(dir, longDir, "ünïcødé file.txt"), "deep");
    writeFileSync(join(dir, "pkg", "src", "index.ts"), "export {}\n");
    writeFileSync(join(dir, "pkg", "package.json"), "{}\n");
    writeFileSync(join(dir, "run.sh"), "#!/bin/sh\n");
    chmodSync(join(dir, "run.sh"), 0o755);
    git("add", ".");
    git("commit", "-q", "-m", "init");
    const sha = git("rev-parse", "HEAD").toString().trim();
    const archive = git("archive", "--format=tar.gz", `--prefix=demo-${sha.slice(0, 7)}/`, "HEAD");
    const fetch = mockFetch({
      "/api/github/archive/acme/demo/main": { body: new Uint8Array(archive) },
      "/api/github/refs/acme/demo/main": { body: { branches: ["main"], tags: [] } },
      "/api/github/archive/acme/demo/refs/heads/main": { body: new Uint8Array(archive) },
    });

    const whole = await importGitHubRepo(source("/github/acme/demo/tree/main"), { fetch });
    expect(whole.commit).toBe(sha);
    expect(whole.files.map((file) => [file.path, file.mode]).sort()).toEqual(
      [
        [`${longDir}/ünïcødé file.txt`, 0o644],
        ["pkg/package.json", 0o644],
        ["pkg/src/index.ts", 0o644],
        ["run.sh", 0o755],
      ].sort(),
    );

    const sub = await importGitHubRepo(source("/github/acme/demo/tree/main/pkg"), { fetch });
    expect(sub.files.map((file) => file.path).sort()).toEqual(["package.json", "src/index.ts"]);
  });
});
