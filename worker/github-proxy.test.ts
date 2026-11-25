import { describe, expect, test } from "bun:test";
import { createGitHubProxy, type GitHubProxyEnv } from "./github-proxy.ts";

interface CacheInit {
  cacheEverything?: boolean;
  cacheTtlByStatus?: Record<string, number>;
}

interface Call {
  readonly url: string;
  readonly init: RequestInit & { cf?: CacheInit };
}

function upstream(handler: (url: string) => Response) {
  const calls: Call[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    return handler(url);
  };
  return { calls, fetch };
}

function get(path: string, init: RequestInit = {}): Request {
  return new Request(`https://sprockt.dev${path}`, {
    ...init,
    headers: { cookie: "session=secret", authorization: "Bearer browser", ...init.headers },
  });
}

const SHA = "0123456789abcdef0123456789abcdef01234567";
const PUBLIC_REPO = {
  name: "demo",
  private: false,
  default_branch: "main",
  size: 1,
  owner: { login: "acme" },
};
const auth = (call: Call | undefined) => new Headers(call?.init.headers).get("authorization");
const redirect = (location: string) => new Response(null, { status: 301, headers: { location } });

describe("GitHub proxy: repo metadata", () => {
  test("returns minimal metadata and never forwards browser headers", async () => {
    const { calls, fetch } = upstream(() =>
      Response.json({
        name: "Demo",
        private: false,
        default_branch: "trunk",
        size: 42,
        owner: { login: "Acme" },
      }),
    );
    const handler = createGitHubProxy({ fetch });
    const response = await handler(get("/api/github/repo/acme/demo"), { GITHUB_TOKEN: "server-token" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      owner: "Acme",
      repo: "Demo",
      defaultBranch: "trunk",
      sizeKiB: 42,
    });
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.github.com/repos/acme/demo");
    expect(auth(calls[0])).toBe("Bearer server-token");
    expect(new Headers(calls[0]?.init.headers).get("cookie")).toBeNull();
    expect(calls[0]?.init.redirect).toBe("manual");
    // An authenticated response stays out of the shared subrequest cache.
    expect(calls[0]?.init.cf).toBeUndefined();
  });

  test("without a token, metadata is cached by status", async () => {
    const { calls, fetch } = upstream(() => Response.json(PUBLIC_REPO));
    await createGitHubProxy({ fetch })(get("/api/github/repo/acme/demo"));
    expect(calls[0]?.init.cf?.cacheTtlByStatus).toEqual({ "200-299": 300, "404": 60, "500-599": 0 });
  });

  test("refuses private repositories even when the token can read them", async () => {
    const { fetch } = upstream(() =>
      Response.json({ name: "secret", private: true, default_branch: "main" }),
    );
    const response = await createGitHubProxy({ fetch })(get("/api/github/repo/acme/secret"), {
      GITHUB_TOKEN: "t",
    });
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("private");
  });

  test("treats metadata that does not say public as private, and unreadable metadata as upstream", async () => {
    const missing = upstream(() => Response.json({ name: "x" }));
    expect((await createGitHubProxy({ fetch: missing.fetch })(get("/api/github/repo/acme/x"))).status).toBe(
      403,
    );
    const notObject = upstream(() => Response.json([1, 2]));
    expect((await createGitHubProxy({ fetch: notObject.fetch })(get("/api/github/repo/acme/x"))).status).toBe(
      502,
    );
  });

  test("maps not found and primary rate limits", async () => {
    const notFound = upstream(() => new Response("{}", { status: 404 }));
    const missing = await createGitHubProxy({ fetch: notFound.fetch })(get("/api/github/repo/acme/none"));
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBe("not-found");

    const reset = Math.floor(Date.now() / 1000) + 120;
    const limited = upstream(
      () =>
        new Response("{}", {
          status: 403,
          headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
        }),
    );
    const response = await createGitHubProxy({ fetch: limited.fetch })(get("/api/github/repo/acme/demo"));
    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body.error).toBe("rate-limited");
    expect(body.retryAfter).toBeGreaterThan(100);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(100);
  });

  test("recognizes a secondary rate limit with quota left and no Retry-After", async () => {
    const { fetch } = upstream(() =>
      Response.json(
        {
          message:
            "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
        },
        { status: 403, headers: { "x-ratelimit-remaining": "4999" } },
      ),
    );
    const response = await createGitHubProxy({ fetch })(get("/api/github/repo/acme/demo"));
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: "rate-limited", retryAfter: 60 });
    expect(response.headers.get("retry-after")).toBe("60");
  });

  test("honours Retry-After on a secondary limit, and a bare 429 waits a minute", async () => {
    const withHeader = upstream(() => new Response("{}", { status: 403, headers: { "retry-after": "17" } }));
    const first = await createGitHubProxy({ fetch: withHeader.fetch })(get("/api/github/repo/acme/demo"));
    expect((await first.json()).retryAfter).toBe(17);
    const bare = upstream(() => new Response("", { status: 429 }));
    const second = await createGitHubProxy({ fetch: bare.fetch })(get("/api/github/archive/acme/demo/main"));
    expect((await second.json()).retryAfter).toBe(60);
  });

  test("a 403 that is not a rate limit stays a generic upstream error", async () => {
    const { fetch } = upstream(() =>
      Response.json(
        { message: "Resource not accessible" },
        { status: 403, headers: { "x-ratelimit-remaining": "10" } },
      ),
    );
    const response = await createGitHubProxy({ fetch })(get("/api/github/repo/acme/demo"));
    expect(response.status).toBe(502);
    expect((await response.json()).error).toBe("upstream");
  });

  test("follows a renamed-repository redirect to the repository-by-id endpoint, with the token", async () => {
    const renamed = upstream((url) =>
      url.endsWith("/repos/acme/old")
        ? redirect("https://api.github.com/repositories/1")
        : Response.json(PUBLIC_REPO),
    );
    const ok = await createGitHubProxy({ fetch: renamed.fetch })(get("/api/github/repo/acme/old"), {
      GITHUB_TOKEN: "t",
    });
    expect(ok.status).toBe(200);
    expect(renamed.calls.map((call) => call.url)).toEqual([
      "https://api.github.com/repos/acme/old",
      "https://api.github.com/repositories/1",
    ]);
    expect(renamed.calls.map(auth)).toEqual(["Bearer t", "Bearer t"]);
  });

  test.each([
    ["another host", "https://evil.example/x"],
    ["codeload, which must never see the token", "https://codeload.github.com/acme/demo/tar.gz/main"],
    ["an unrelated API path", "https://api.github.com/user"],
    ["a repository sub-resource", "https://api.github.com/repos/acme/demo/collaborators"],
    ["plain http", "http://api.github.com/repos/acme/demo"],
    ["a query string", "https://api.github.com/repos/acme/demo?x=1"],
  ])("refuses a metadata redirect to %s", async (_, location) => {
    const { calls, fetch } = upstream(() => redirect(location));
    const response = await createGitHubProxy({ fetch })(get("/api/github/repo/acme/demo"), {
      GITHUB_TOKEN: "secret",
    });
    expect(response.status).toBe(502);
    expect(calls).toHaveLength(1);
  });

  test("gives up after too many redirects", async () => {
    const { calls, fetch } = upstream(() => redirect("https://api.github.com/repositories/1"));
    const response = await createGitHubProxy({ fetch })(get("/api/github/repo/acme/demo"));
    expect(response.status).toBe(502);
    expect(calls).toHaveLength(4);
  });
});

describe("GitHub proxy: matching refs", () => {
  test("lists branch and tag names that start with the segment, for public repositories only", async () => {
    const { calls, fetch } = upstream((url) => {
      if (url.endsWith("/repos/acme/demo")) return Response.json(PUBLIC_REPO);
      if (url.includes("/matching-refs/heads/")) {
        return Response.json([{ ref: "refs/heads/feature/x" }, { ref: "refs/heads/feature-y" }, { nope: 1 }]);
      }
      return Response.json([{ ref: "refs/tags/feature" }]);
    });
    const response = await createGitHubProxy({ fetch })(get("/api/github/refs/acme/demo/feature"), {
      GITHUB_TOKEN: "t",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ branches: ["feature/x", "feature-y"], tags: ["feature"] });
    expect(calls.map((call) => call.url).sort()).toEqual([
      "https://api.github.com/repos/acme/demo",
      "https://api.github.com/repos/acme/demo/git/matching-refs/heads/feature",
      "https://api.github.com/repos/acme/demo/git/matching-refs/tags/feature",
    ]);
  });

  test("encodes non-ASCII segments and treats an empty repository as having no refs", async () => {
    const { calls, fetch } = upstream((url) =>
      url.endsWith("/repos/acme/demo") ? Response.json(PUBLIC_REPO) : new Response("{}", { status: 409 }),
    );
    const response = await createGitHubProxy({ fetch })(get("/api/github/refs/acme/demo/caf%C3%A9"));
    expect(await response.json()).toEqual({ branches: [], tags: [] });
    expect(calls[1]?.url).toBe("https://api.github.com/repos/acme/demo/git/matching-refs/heads/caf%C3%A9");
  });

  test.each(["release.", "%40"])(
    "accepts the first component %p, which is only valid as part of a longer ref",
    async (segment) => {
      const { calls, fetch } = upstream((url) =>
        url.endsWith("/repos/acme/demo") ? Response.json(PUBLIC_REPO) : Response.json([]),
      );
      const response = await createGitHubProxy({ fetch })(get(`/api/github/refs/acme/demo/${segment}`));
      expect(response.status).toBe(200);
      expect(calls[1]?.url).toBe(`https://api.github.com/repos/acme/demo/git/matching-refs/heads/${segment}`);
    },
  );

  test("refuses a ref list larger than it reads, without buffering all of it", async () => {
    const huge = JSON.stringify(
      Array.from({ length: 60_000 }, (_, index) => ({ ref: `refs/heads/b/${index}` })),
    );
    const { fetch } = upstream((url) =>
      url.endsWith("/repos/acme/demo") ? Response.json(PUBLIC_REPO) : new Response(huge),
    );
    const response = await createGitHubProxy({ fetch })(get("/api/github/refs/acme/demo/b"));
    expect(response.status).toBe(502);
    expect((await response.json()).message).toContain("Too many branches or tags");
  });

  test("the API limiter applies to repo and refs, not to archives", async () => {
    const keys: string[] = [];
    const env: GitHubProxyEnv = {
      GITHUB_API_LIMITER: {
        limit: async ({ key }) => {
          keys.push(key);
          return { success: false };
        },
      },
    };
    const { calls, fetch } = upstream(() => new Response(new Uint8Array([1])));
    const handler = createGitHubProxy({ fetch });
    const statuses = await Promise.all(
      [
        "/api/github/repo/acme/demo",
        "/api/github/refs/acme/demo/main",
        "/api/github/archive/acme/demo/main",
      ].map(async (path) => (await handler(get(path), env)).status),
    );
    expect(statuses).toEqual([429, 429, 200]);
    expect(keys).toEqual(["unknown", "unknown"]);
    expect(calls.map((call) => call.url)).toEqual(["https://codeload.github.com/acme/demo/tar.gz/main"]);
  });

  test("a limiter that allows the request lets it through", async () => {
    const env: GitHubProxyEnv = { GITHUB_API_LIMITER: { limit: async () => ({ success: true }) } };
    const { fetch } = upstream(() => Response.json(PUBLIC_REPO));
    expect((await createGitHubProxy({ fetch })(get("/api/github/repo/acme/demo"), env)).status).toBe(200);
  });

  test("refuses to list refs of a private repository", async () => {
    const { calls, fetch } = upstream(() => Response.json({ name: "s", private: true }));
    const response = await createGitHubProxy({ fetch })(get("/api/github/refs/acme/s/main"), {
      GITHUB_TOKEN: "t",
    });
    expect(response.status).toBe(403);
    expect(calls).toHaveLength(1);
  });
});

describe("GitHub proxy: archives", () => {
  test("streams the codeload tarball with a short cache for branches", async () => {
    const body = new Uint8Array([0x1f, 0x8b, 1, 2, 3]);
    const { calls, fetch } = upstream(() => new Response(body, { headers: { "content-length": "5" } }));
    const response = await createGitHubProxy({ fetch })(
      get("/api/github/archive/acme/demo/refs/heads/feature/x"),
      {
        GITHUB_TOKEN: "server-token",
      },
    );
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);
    expect(response.headers.get("content-type")).toBe("application/gzip");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(calls[0]?.url).toBe("https://codeload.github.com/acme/demo/tar.gz/refs/heads/feature/x");
    expect(calls[0]?.init.cf?.cacheTtlByStatus).toEqual({ "200-299": 300, "404": 60, "500-599": 0 });
    // The token is for the API only; codeload must never see it.
    expect(auth(calls[0])).toBeNull();
  });

  test("caches commit archives forever, but not their errors", async () => {
    const { calls, fetch } = upstream(() => new Response(new Uint8Array([1])));
    const response = await createGitHubProxy({ fetch })(get(`/api/github/archive/acme/demo/${SHA}`));
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(calls[0]?.init.cf?.cacheTtlByStatus).toEqual({ "200-299": 31536000, "404": 60, "500-599": 0 });
  });

  test("percent-encodes each segment of a non-ASCII ref", async () => {
    const { calls, fetch } = upstream(() => new Response(new Uint8Array([1])));
    await createGitHubProxy({ fetch })(get("/api/github/archive/acme/demo/release/caf%C3%A9"));
    expect(calls[0]?.url).toBe("https://codeload.github.com/acme/demo/tar.gz/release/caf%C3%A9");
  });

  test("follows a codeload redirect for a renamed repository, but not off codeload", async () => {
    const renamed = upstream((url) =>
      url.includes("/old/")
        ? redirect("https://codeload.github.com/acme/new/tar.gz/main")
        : new Response(new Uint8Array([1])),
    );
    expect(
      (await createGitHubProxy({ fetch: renamed.fetch })(get("/api/github/archive/acme/old/main"))).status,
    ).toBe(200);
  });

  test.each(["https://api.github.com/repos/acme/demo", "https://codeload.github.com/acme/demo/zip/main"])(
    "refuses an archive redirect to %s",
    async (location) => {
      const offsite = upstream(() => redirect(location));
      const response = await createGitHubProxy({ fetch: offsite.fetch })(
        get("/api/github/archive/acme/demo/main"),
      );
      expect(response.status).toBe(502);
      expect(offsite.calls).toHaveLength(1);
    },
  );

  test("refuses archives over the size limit", async () => {
    const { fetch } = upstream(
      () => new Response(new Uint8Array(10), { headers: { "content-length": "10" } }),
    );
    const env: GitHubProxyEnv = { GITHUB_PROXY_MAX_ARCHIVE_BYTES: "5" };
    const response = await createGitHubProxy({ fetch })(get("/api/github/archive/acme/demo/main"), env);
    expect(response.status).toBe(413);
    expect((await response.json()).error).toBe("too-large");
  });

  test("cuts off an archive without a length once it passes the limit", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4));
        controller.enqueue(new Uint8Array(4));
        controller.close();
      },
    });
    const { fetch } = upstream(() => new Response(stream));
    const response = await createGitHubProxy({ fetch })(get("/api/github/archive/acme/demo/main"), {
      GITHUB_PROXY_MAX_ARCHIVE_BYTES: "6",
    });
    expect(response.status).toBe(200);
    await expect(response.arrayBuffer()).rejects.toThrow("larger than 6 bytes");
  });

  test("maps a missing ref to not found", async () => {
    const { fetch } = upstream(() => new Response("", { status: 404 }));
    const response = await createGitHubProxy({ fetch })(get("/api/github/archive/acme/demo/nope"));
    expect(response.status).toBe(404);
  });

  test("HEAD returns headers without a body", async () => {
    const { fetch } = upstream(
      () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-length": "3" } }),
    );
    const response = await createGitHubProxy({ fetch })(
      get("/api/github/archive/acme/demo/main", { method: "HEAD" }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/gzip");
  });
});

describe("GitHub proxy: refuses everything else", () => {
  const never = upstream(() => {
    throw new Error("upstream must not be called");
  });
  const handler = createGitHubProxy({ fetch: never.fetch });

  test.each([
    ["/api/github/archive/acme/demo/..%2F..%2Fetc", 400],
    ["/api/github/archive/acme/demo/a..b", 400],
    ["/api/github/archive/acme/demo/main%3Fx=1", 400],
    ["/api/github/archive/acme/demo/has%20space", 400],
    ["/api/github/archive/-bad/demo/main", 400],
    ["/api/github/archive/acme/demo%2F..%2Fother/main", 400],
    ["/api/github/archive/acme/demo", 404],
    ["/api/github/repo/acme/demo/extra", 404],
    ["/api/github/refs/acme/demo", 404],
    ["/api/github/refs/acme/demo/a/b", 404],
    ["/api/github/refs/acme/demo/.hidden", 400],
    ["/api/github/users/acme", 400],
    ["/api/github/contents/acme/demo/x", 404],
    ["/api/github/%E0%A4%A", 400],
    ["/api/other", 404],
  ])("%s -> %d", async (path, status) => {
    const response = await handler(get(path));
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("only GET and HEAD", async () => {
    const response = await handler(get("/api/github/repo/acme/demo", { method: "POST" }));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });

  test("never reached upstream", () => {
    expect(never.calls).toHaveLength(0);
  });

  test("honours a custom prefix", async () => {
    const { calls, fetch } = upstream(() => new Response(new Uint8Array([1])));
    const custom = createGitHubProxy({ prefix: "/gh/", fetch });
    expect((await custom(get("/gh/archive/acme/demo/main"))).status).toBe(200);
    expect(calls).toHaveLength(1);
  });
});
