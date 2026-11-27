// Connect/Node middleware adapter for the Cloudflare Worker GitHub proxy so `vite dev` and
// `vite preview` serve `/api/github/*` with the same validation and headers as production.
import type { IncomingMessage, ServerResponse } from "node:http";
import { createGitHubProxy, GITHUB_PROXY_PREFIX, type GitHubProxyEnv } from "./github-proxy.ts";

export type NextFunction = (error?: unknown) => void;
export type Middleware = (request: IncomingMessage, response: ServerResponse, next: NextFunction) => void;

const ALLOWED_METHODS = new Set(["GET", "HEAD"]);

function toHeaders(raw: IncomingMessage["headers"]): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(", "));
  }
  return headers;
}

function sendMethodNotAllowed(response: ServerResponse): void {
  response.statusCode = 405;
  response.setHeader("Allow", "GET, HEAD");
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end("Only GET and HEAD are allowed.\n");
}

function waitForDrain(response: ServerResponse): Promise<void> {
  if (response.destroyed || response.writableEnded) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const finish = () => {
      response.off("drain", finish);
      response.off("close", finish);
      response.off("error", finish);
      resolve();
    };
    response.once("drain", finish);
    response.once("close", finish);
    response.once("error", finish);
  });
}

function writeChunk(response: ServerResponse, chunk: Uint8Array): Promise<void> {
  if (response.write(chunk)) return Promise.resolve();
  return waitForDrain(response);
}

async function pipeBody(body: ReadableStream<Uint8Array>, response: ServerResponse): Promise<void> {
  const reader = body.getReader();
  let completed = false;
  try {
    while (!response.destroyed) {
      // oxlint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      if (response.destroyed) break;
      // oxlint-disable-next-line no-await-in-loop
      await writeChunk(response, value);
    }
  } catch (error: unknown) {
    // Destroy the response on mid-stream failure so clients never treat a truncated body as 200 OK.
    if (!response.destroyed) {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    }
    return;
  } finally {
    await reader.cancel().catch(() => undefined);
    if (completed && !response.destroyed && !response.writableEnded) response.end();
  }
}

async function serveProxyRequest(
  handler: ReturnType<typeof createGitHubProxy>,
  env: () => GitHubProxyEnv,
  request: IncomingMessage,
  response: ServerResponse,
  next: NextFunction,
): Promise<void> {
  const method = (request.method ?? "GET").toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    sendMethodNotAllowed(response);
    return;
  }
  const controller = new AbortController();
  response.once("close", () => {
    if (!response.writableEnded) controller.abort();
  });
  try {
    const webRequest = new Request(new URL(request.url ?? "/", "http://localhost"), {
      method,
      headers: toHeaders(request.headers),
      signal: controller.signal,
    });
    const proxied = await handler(webRequest, env());
    if (response.destroyed) {
      await proxied.body?.cancel().catch(() => undefined);
      return;
    }
    response.statusCode = proxied.status;
    proxied.headers.forEach((value, key) => response.setHeader(key, value));
    if (!proxied.body || method === "HEAD") {
      response.end();
      return;
    }
    await pipeBody(proxied.body, response);
  } catch (error: unknown) {
    if (!response.headersSent && !response.writableEnded) {
      next(error);
      return;
    }
    if (!response.destroyed) {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

export function createGitHubProxyMiddleware(
  handler: ReturnType<typeof createGitHubProxy> = createGitHubProxy(),
  env: () => GitHubProxyEnv = () => ({ GITHUB_TOKEN: process.env.GITHUB_TOKEN }),
): Middleware {
  return (request, response, next) => {
    const pathname = (request.url ?? "").split("?", 1)[0] ?? "";
    if (pathname !== GITHUB_PROXY_PREFIX && !pathname.startsWith(`${GITHUB_PROXY_PREFIX}/`)) {
      next();
      return;
    }
    void serveProxyRequest(handler, env, request, response, next);
  };
}
