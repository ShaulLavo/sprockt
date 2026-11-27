import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, test } from "bun:test";
import { createGitHubProxy } from "./github-proxy.ts";
import { createGitHubProxyMiddleware } from "./github-proxy-middleware.ts";

class MockServerResponse extends EventEmitter {
  statusCode = 200;
  headersSent = false;
  writableEnded = false;
  destroyed = false;
  destroyedError: Error | undefined;
  backpressure = false;
  readonly headers = new Map<string, string>();
  readonly chunks: Uint8Array[] = [];
  private readonly done = Promise.withResolvers<void>();
  private writeWaiter: (() => void) | undefined;

  setHeader(name: string, value: string): void {
    this.headers.set(name.toLowerCase(), value);
  }

  write(chunk: Uint8Array | string): boolean {
    this.headersSent = true;
    this.chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
    this.writeWaiter?.();
    this.writeWaiter = undefined;
    return !this.backpressure;
  }

  nextWrite(): Promise<void> {
    return new Promise((resolve) => {
      this.writeWaiter = resolve;
    });
  }

  end(chunk?: Uint8Array | string): this {
    if (chunk !== undefined) this.write(chunk);
    this.headersSent = true;
    this.writableEnded = true;
    this.done.resolve();
    return this;
  }

  destroy(error?: Error): this {
    this.destroyed = true;
    this.destroyedError = error;
    this.done.resolve();
    return this;
  }

  settled(): Promise<void> {
    return this.done.promise;
  }
}

function mockRequest(method: string, url: string): IncomingMessage {
  return { method, url, headers: {} } as unknown as IncomingMessage;
}

describe("GitHub proxy Connect middleware", () => {
  test("passes non-proxy paths through to next()", () => {
    const middleware = createGitHubProxyMiddleware();
    const response = new MockServerResponse();
    let called = false;
    middleware(mockRequest("GET", "/index.html"), response as unknown as ServerResponse, () => {
      called = true;
    });
    expect(called).toBe(true);
    expect(response.writableEnded).toBe(false);
  });

  test("rejects unsupported methods like TRACE and POST with 405 before constructing Request", async () => {
    let handlerCalls = 0;
    const handler = async () => {
      handlerCalls += 1;
      return new Response("ok");
    };
    const middleware = createGitHubProxyMiddleware(handler);

    for (const method of ["TRACE", "POST", "DELETE"]) {
      const response = new MockServerResponse();
      let nextError: unknown;
      middleware(
        mockRequest(method, "/api/github/release/acme/demo/v1/pkg.tgz"),
        response as unknown as ServerResponse,
        (error) => {
          nextError = error;
        },
      );
      // oxlint-disable-next-line no-await-in-loop
      await response.settled();
      expect(nextError).toBeUndefined();
      expect(response.statusCode).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, HEAD");
      expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    }
    expect(handlerCalls).toBe(0);
  });

  test("destroys the response on a mid-stream upstream error instead of ending 200 OK", async () => {
    const failingStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x1f, 0x8b, 0x08]));
      },
      pull(controller) {
        controller.error(new Error("upstream truncated"));
      },
    });
    const proxy = createGitHubProxy({
      fetch: async (url) => {
        if (url.startsWith("https://github.com/")) {
          return new Response(null, {
            status: 302,
            headers: {
              location: "https://release-assets.githubusercontent.com/github-production-release-asset/1/a",
            },
          });
        }
        return new Response(failingStream, {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        });
      },
    });
    const middleware = createGitHubProxyMiddleware(proxy);
    const response = new MockServerResponse();
    middleware(
      mockRequest("GET", "/api/github/release/acme/demo/v1/pkg.tgz"),
      response as unknown as ServerResponse,
      () => {},
    );
    await response.settled();

    expect(response.destroyed).toBe(true);
    expect(response.writableEnded).toBe(false);
    expect(response.destroyedError?.message).toContain("upstream truncated");
  });

  test("streams complete proxied release tarballs and handles HEAD cleanly", async () => {
    const payload = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xaa, 0xbb]);
    const proxy = createGitHubProxy({
      fetch: async (url) => {
        if (url.startsWith("https://github.com/")) {
          return new Response(null, {
            status: 302,
            headers: {
              location: "https://release-assets.githubusercontent.com/github-production-release-asset/1/ok",
            },
          });
        }
        return new Response(payload, {
          status: 200,
          headers: {
            "content-type": "application/octet-stream",
            "content-length": String(payload.byteLength),
          },
        });
      },
    });
    const middleware = createGitHubProxyMiddleware(proxy);

    const getRes = new MockServerResponse();
    middleware(
      mockRequest("GET", "/api/github/release/acme/demo/v1/pkg.tgz"),
      getRes as unknown as ServerResponse,
      () => {},
    );
    await getRes.settled();
    expect(getRes.statusCode).toBe(200);
    expect(getRes.writableEnded).toBe(true);
    expect(getRes.destroyed).toBe(false);
    expect(Buffer.concat(getRes.chunks)).toEqual(Buffer.from(payload));

    const headRes = new MockServerResponse();
    middleware(
      mockRequest("HEAD", "/api/github/release/acme/demo/v1/pkg.tgz"),
      headRes as unknown as ServerResponse,
      () => {},
    );
    await headRes.settled();
    expect(headRes.statusCode).toBe(200);
    expect(headRes.writableEnded).toBe(true);
    expect(headRes.chunks).toHaveLength(0);
  });

  test("pauses upstream reads on backpressure until drain and cancels on disconnect", async () => {
    let pulls = 0;
    let cancelled = false;
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4]), new Uint8Array([5, 6])];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[pulls];
        pulls += 1;
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const middleware = createGitHubProxyMiddleware(
      async () =>
        new Response(body, { status: 200, headers: { "content-type": "application/octet-stream" } }),
    );
    const response = new MockServerResponse();
    response.backpressure = true;

    const firstWrite = response.nextWrite();
    middleware(
      mockRequest("GET", "/api/github/release/acme/demo/v1/pkg.tgz"),
      response as unknown as ServerResponse,
      () => {},
    );
    await firstWrite;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(response.chunks).toHaveLength(1);

    // Emit drain to allow the second chunk, then disconnect while paused on the second write.
    const secondWrite = response.nextWrite();
    response.emit("drain");
    await secondWrite;
    expect(response.chunks).toHaveLength(2);

    response.destroyed = true;
    response.emit("close");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(response.chunks).toHaveLength(2);
    expect(cancelled).toBe(true);
  });

  test("forwards client disconnect abort signal to every upstream redirect hop", async () => {
    const signals: AbortSignal[] = [];
    const cdnStarted = Promise.withResolvers<void>();
    const proxy = createGitHubProxy({
      fetch: async (url, init) => {
        if (init?.signal) signals.push(init.signal);
        if (url.startsWith("https://github.com/")) {
          return new Response(null, {
            status: 302,
            headers: {
              location:
                "https://release-assets.githubusercontent.com/github-production-release-asset/1/stall",
            },
          });
        }
        cdnStarted.resolve();
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("upstream aborted")), {
            once: true,
          });
        });
      },
    });
    const middleware = createGitHubProxyMiddleware(proxy);
    const response = new MockServerResponse();
    middleware(
      mockRequest("GET", "/api/github/release/acme/demo/v1/pkg.tgz"),
      response as unknown as ServerResponse,
      () => {},
    );

    await cdnStarted.promise;
    expect(signals).toHaveLength(2);
    expect(signals[1]?.aborted).toBe(false);

    response.emit("close");
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(true);
  });
});
