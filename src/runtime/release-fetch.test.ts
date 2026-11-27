import { describe, expect, test } from "bun:test";
import {
  createRuntimeFetch,
  parseGitHubReleaseTarballUrl,
  rewriteGitHubReleaseTarballUrl,
} from "./release-fetch";

const TARBALL_INIT: RequestInit = {
  method: "GET",
  headers: [["accept", "application/vnd.bun.install-tarball"]],
};

describe("parseGitHubReleaseTarballUrl", () => {
  test("parses valid public GitHub Release .tgz URLs, including slash tags and latest release URLs", () => {
    expect(
      parseGitHubReleaseTarballUrl(
        "https://github.com/ShaulLavo/waffle/releases/download/programs-v0.0.23/waffle-base-0.0.23.tgz",
      ),
    ).toEqual({
      kind: "tag",
      owner: "ShaulLavo",
      repo: "waffle",
      tag: "programs-v0.0.23",
      asset: "waffle-base-0.0.23.tgz",
    });

    expect(
      parseGitHubReleaseTarballUrl(
        "https://github.com/acme/mono/releases/download/packages/v1.0.0+build/pkg-1.0.0+build.tgz",
      ),
    ).toEqual({
      kind: "tag",
      owner: "acme",
      repo: "mono",
      tag: "packages/v1.0.0+build",
      asset: "pkg-1.0.0+build.tgz",
    });

    expect(
      parseGitHubReleaseTarballUrl(
        "https://github.com/ShaulLavo/waffle/releases/latest/download/waffle-base.tgz",
      ),
    ).toEqual({
      kind: "latest",
      owner: "ShaulLavo",
      repo: "waffle",
      asset: "waffle-base.tgz",
    });
  });

  test.each([
    "https://registry.npmjs.org/react/-/react-19.3.1.tgz",
    "http://github.com/acme/demo/releases/download/v1/pkg.tgz",
    "https://github.com:8443/acme/demo/releases/download/v1/pkg.tgz",
    "https://user:pass@github.com/acme/demo/releases/download/v1/pkg.tgz",
    "https://github.com/acme/demo/releases/download/v1/pkg.tgz?token=1",
    "https://github.com/acme/demo/releases/download/v1/pkg.zip",
    "https://github.com/acme/demo/releases/download/v1/.hidden.tgz",
    "https://github.com/acme/demo/releases/download/v1/..%2Fpkg.tgz",
    "https://github.com/acme/demo/archive/refs/tags/v1.tgz",
    "https://github.com/-bad/demo/releases/download/v1/pkg.tgz",
    "not-a-url",
  ])("rejects %s", (url) => {
    expect(parseGitHubReleaseTarballUrl(url)).toBeUndefined();
  });
});

describe("rewriteGitHubReleaseTarballUrl and createRuntimeFetch", () => {
  test("rewrites unauthenticated bun install tarball fetches to Sprockt's same-origin proxy", () => {
    const rewritten = rewriteGitHubReleaseTarballUrl(
      "https://github.com/ShaulLavo/workbench/releases/download/v0.1.17/shaulavo-workbench-core-0.1.17.tgz",
      TARBALL_INIT,
      { origin: "https://sprockt.dev" },
    );
    expect(rewritten).toBe(
      "https://sprockt.dev/api/github/release/ShaulLavo/workbench/v0.1.17/shaulavo-workbench-core-0.1.17.tgz",
    );

    const latest = rewriteGitHubReleaseTarballUrl(
      "https://github.com/ShaulLavo/workbench/releases/latest/download/shaulavo-workbench-core.tgz",
      TARBALL_INIT,
      { origin: "https://sprockt.dev" },
    );
    expect(latest).toBe(
      "https://sprockt.dev/api/github/release-latest/ShaulLavo/workbench/shaulavo-workbench-core.tgz",
    );

    // A literal tag named "latest" keeps the tagged route rather than colliding with release-latest.
    const literalLatestTag = rewriteGitHubReleaseTarballUrl(
      "https://github.com/ShaulLavo/workbench/releases/download/latest/pkg.tgz",
      TARBALL_INIT,
      { origin: "https://sprockt.dev" },
    );
    expect(literalLatestTag).toBe(
      "https://sprockt.dev/api/github/release/ShaulLavo/workbench/latest/pkg.tgz",
    );
  });

  test("ignores ordinary fetches, metadata fetches, POSTs, and authenticated requests", () => {
    const url = "https://github.com/acme/demo/releases/download/v1.0.0/demo-1.0.0.tgz";
    const config = { origin: "https://sprockt.dev" };
    expect(rewriteGitHubReleaseTarballUrl(url, { method: "GET" }, config)).toBeUndefined();
    expect(
      rewriteGitHubReleaseTarballUrl(
        url,
        { method: "GET", headers: { accept: "application/vnd.npm.install-v1+json" } },
        config,
      ),
    ).toBeUndefined();
    expect(
      rewriteGitHubReleaseTarballUrl(
        url,
        { method: "POST", headers: { accept: "application/vnd.bun.install-tarball" } },
        config,
      ),
    ).toBeUndefined();
    expect(
      rewriteGitHubReleaseTarballUrl(
        url,
        {
          method: "GET",
          headers: { accept: "application/vnd.bun.install-tarball", authorization: "Bearer secret" },
        },
        config,
      ),
    ).toBeUndefined();
  });

  test("routes all GitHub release downloads through releaseFetch (HTTP cache) and other URLs through baseFetch", async () => {
    const baseSeen: { url: string; init: RequestInit }[] = [];
    const releaseSeen: { url: string; init: RequestInit }[] = [];
    const runtimeFetch = createRuntimeFetch({
      origin: "https://sprockt.dev",
      baseFetch: async (url, init) => {
        baseSeen.push({ url, init });
        return new Response("ok");
      },
      releaseFetch: async (url, init) => {
        releaseSeen.push({ url, init });
        return new Response("release");
      },
    });

    await runtimeFetch(
      "https://github.com/ShaulLavo/waffle/releases/download/programs-v0.0.23/waffle-base-0.0.23.tgz",
      TARBALL_INIT,
    );
    await runtimeFetch(
      "https://github.com/ShaulLavo/waffle/releases/latest/download/waffle-base.tgz",
      TARBALL_INIT,
    );
    await runtimeFetch("https://registry.npmjs.org/react/-/react-19.3.1.tgz", TARBALL_INIT);

    expect(releaseSeen.map((entry) => entry.url)).toEqual([
      "https://sprockt.dev/api/github/release/ShaulLavo/waffle/programs-v0.0.23/waffle-base-0.0.23.tgz",
      "https://sprockt.dev/api/github/release-latest/ShaulLavo/waffle/waffle-base.tgz",
    ]);
    expect(baseSeen.map((entry) => entry.url)).toEqual([
      "https://registry.npmjs.org/react/-/react-19.3.1.tgz",
    ]);
    expect(releaseSeen[0]?.init).toBe(TARBALL_INIT);
    expect(baseSeen[0]?.init).toBe(TARBALL_INIT);
  });
});
