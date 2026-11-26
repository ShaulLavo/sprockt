import { describe, expect, test } from "bun:test";
import { previewOrigin, previewOriginId } from "bun-wasm/preview-origins";
import { handlePreviewHostRequest, listed, type PreviewHostsEnv } from "./preview.ts";

const FILES: Readonly<Record<string, string>> = {
  "/sw.js": "/* worker */",
  "/relay.html": '<script>const ide = "__BUNWASM_PREVIEW_IDE_ORIGINS__";</script>',
  "/bootstrap.html": "<p>cold load</p>",
  "/top.html": "<p>open it from the IDE</p>",
};

function env(overrides: Partial<PreviewHostsEnv> = {}): PreviewHostsEnv & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    ASSETS: {
      fetch: async (request) => {
        const { pathname } = new URL(request.url);
        asked.push(pathname);
        const file = FILES[pathname];
        return file === undefined ? new Response("missing", { status: 404 }) : new Response(file);
      },
    },
    PREVIEW_DOMAIN: "sprockt.dev",
    IDE_ORIGINS: "https://sprockt.dev, https://bun.sprockt.dev",
    ...overrides,
  };
}

async function host(port = 5173): Promise<string> {
  return previewOrigin(
    { domain: "sprockt.dev" },
    await previewOriginId("https://sprockt.dev", "workspace"),
    port,
  );
}

const framed = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" };
const topLevel = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };

describe("preview hosts", () => {
  test("serve the origin's service worker with the IDE origins that may connect to it", async () => {
    const response = await handlePreviewHostRequest(
      new Request(`${await host()}/__bunwasm-preview/sw.js`),
      env(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toStartWith("text/javascript");
    expect(response.headers.get("service-worker-allowed")).toBe("/");
    const script = await response.text();
    expect(script).toContain('["https://sprockt.dev","https://bun.sprockt.dev"]');
    expect(script).toEndWith("/* worker */");
  });

  test("serve the relay page, framable by the IDE origins only and inside an isolated page", async () => {
    const response = await handlePreviewHostRequest(
      new Request(`${await host()}/__bunwasm-preview/relay.html`),
      env(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe(
      "frame-ancestors https://sprockt.dev https://bun.sprockt.dev",
    );
    // The IDE page is cross-origin isolated: a frame without these is refused by the browser.
    expect(response.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(await response.text()).toContain('const ide = ["https://sprockt.dev","https://bun.sprockt.dev"];');
  });

  test("a framed page gets the cold-load page; a tab opened on the host is refused", async () => {
    const origin = await host();
    const inFrame = await handlePreviewHostRequest(
      new Request(`${origin}/about`, { headers: framed }),
      env(),
    );
    expect(inFrame.status).toBe(200);
    expect(await inFrame.text()).toBe("<p>cold load</p>");
    const inTab = await handlePreviewHostRequest(
      new Request(`${origin}/about`, { headers: topLevel }),
      env(),
    );
    expect(inTab.status).toBe(403);
    expect(await inTab.text()).toBe("<p>open it from the IDE</p>");
  });

  test("answer nothing else: no asset by its own name, no other method, and no cookies", async () => {
    const origin = await host();
    const bindings = env();
    const responses = await Promise.all([
      handlePreviewHostRequest(new Request(`${origin}/sw.js`), bindings),
      handlePreviewHostRequest(new Request(`${origin}/relay.html`), bindings),
      handlePreviewHostRequest(new Request(`${origin}/api`, { method: "POST" }), bindings),
      handlePreviewHostRequest(new Request(`${origin}/assets/app.js`), bindings),
    ]);
    expect(responses.map((response) => response.status)).toEqual([503, 503, 503, 503]);
    expect(responses.every((response) => response.headers.get("set-cookie") === null)).toBe(true);
    expect(bindings.asked).toEqual([]);
  });

  test("a name that is not a preview host gets a 404 and never a file", async () => {
    const bindings = env();
    const names = [
      "https://sprockt.dev/",
      "https://x-pv.sprockt.dev/sw.js",
      "https://bun.sprockt.dev/relay.html",
    ];
    const responses = await Promise.all(
      names.map((name) => handlePreviewHostRequest(new Request(name, { headers: framed }), bindings)),
    );
    expect(responses.map((response) => response.status)).toEqual([404, 404, 404]);
    expect(bindings.asked).toEqual([]);
  });

  test("a host of another domain is not this Worker's, whatever its shape", async () => {
    const id = await previewOriginId("https://sprockt.dev", "workspace");
    const response = await handlePreviewHostRequest(
      new Request(`https://${id}-5173-pv.example.com/`, { headers: framed }),
      env(),
    );
    expect(response.status).toBe(404);
  });

  test("a missing file fails loudly instead of answering with an empty page", async () => {
    const bindings = env({ ASSETS: { fetch: async () => new Response("missing", { status: 404 }) } });
    const request = new Request(`${await host()}/__bunwasm-preview/relay.html`);
    expect(handlePreviewHostRequest(request, bindings)).rejects.toThrow("relay.html");
  });
});

test("the list of IDE origins ignores spaces and empty entries", () => {
  expect(listed("https://sprockt.dev, https://bun.sprockt.dev,,")).toEqual([
    "https://sprockt.dev",
    "https://bun.sprockt.dev",
  ]);
  expect(listed("")).toEqual([]);
});
