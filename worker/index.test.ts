import { describe, expect, test } from "bun:test";
import { handleRequest, type WorkerEnv } from "./index.ts";

function env(overrides: Partial<WorkerEnv> = {}): WorkerEnv & { assetCalls: string[] } {
  const assetCalls: string[] = [];
  return {
    assetCalls,
    ASSETS: {
      fetch: async (request) => {
        assetCalls.push(new URL(request.url).pathname);
        return new Response("asset");
      },
    },
    ...overrides,
  };
}

describe("worker entry", () => {
  test("hands every non-API path to the static assets, and sets no cookies", async () => {
    const bindings = env();
    const paths = ["/", "/w/abc", "/github/acme/demo", "/api", "/api/other", "/assets/app.js"];
    const responses = await Promise.all(
      paths.map((path) => handleRequest(new Request(`https://sprockt.dev${path}`), bindings)),
    );
    expect(await Promise.all(responses.map((response) => response.text()))).toEqual(paths.map(() => "asset"));
    expect(responses.every((response) => response.headers.get("set-cookie") === null)).toBe(true);
    expect(bindings.assetCalls).toEqual([
      "/",
      "/w/abc",
      "/github/acme/demo",
      "/api",
      "/api/other",
      "/assets/app.js",
    ]);
  });

  test("serves /api/github/* from the proxy", async () => {
    const bindings = env();
    const response = await handleRequest(new Request("https://sprockt.dev/api/github/repo/-bad/x"), bindings);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid-source");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(bindings.assetCalls).toEqual([]);
  });

  test("the API limiter answers 429 with a retry time before any upstream call", async () => {
    const keys: string[] = [];
    const bindings = env({
      GITHUB_API_LIMITER: {
        limit: async ({ key }) => {
          keys.push(key);
          return { success: false };
        },
      },
    });
    const request = new Request("https://sprockt.dev/api/github/refs/acme/demo/main", {
      headers: { "cf-connecting-ip": "203.0.113.7" },
    });
    const response = await handleRequest(request, bindings);
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: "rate-limited", retryAfter: 60 });
    expect(response.headers.get("retry-after")).toBe("60");
    expect(keys).toEqual(["203.0.113.7"]);
  });
});
