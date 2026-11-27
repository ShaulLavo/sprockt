import { defineConfig, type Connect, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { previewScripts } from "./src/preview/vite-plugin";
import { createGitHubProxy, GITHUB_PROXY_PREFIX } from "./worker/github-proxy.ts";

// Waffle shares process state through SharedArrayBuffer, so every response needs cross-origin
// isolation. Production gets the same headers from public/_headers.
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
};

const isolate: Connect.NextHandleFunction = (_request, response, next) => {
  for (const [name, value] of Object.entries(isolation)) response.setHeader(name, value);
  next();
};

/**
 * Sets the isolation headers on every response of the dev and preview servers. Vite's own
 * `headers` option leaves them off `304 Not Modified`, and Safari then refuses to start a
 * worker whose script it revalidated.
 */
function crossOriginIsolation(): Plugin {
  return {
    name: "sprockt:cross-origin-isolation",
    configureServer: (server) => void server.middlewares.use(isolate),
    configurePreviewServer: (server) => void server.middlewares.use(isolate),
  };
}

function requestHeaders(raw: Readonly<Record<string, string | string[] | undefined>>): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(", "));
  }
  return headers;
}

async function pipeProxiedBody(
  body: ReadableStream<Uint8Array>,
  response: Parameters<Connect.NextHandleFunction>[1],
): Promise<void> {
  const reader = body.getReader();
  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done || response.destroyed) break;
      response.write(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    if (!response.writableEnded) response.end();
  }
}

async function handleGitHubProxy(
  handler: ReturnType<typeof createGitHubProxy>,
  request: Parameters<Connect.NextHandleFunction>[0],
  response: Parameters<Connect.NextHandleFunction>[1],
  next: Parameters<Connect.NextHandleFunction>[2],
): Promise<void> {
  const method = request.method ?? "GET";
  const controller = new AbortController();
  response.once("close", () => {
    if (!response.writableEnded) controller.abort();
  });
  const webRequest = new Request(new URL(request.url ?? "/", "http://localhost"), {
    method,
    headers: requestHeaders(request.headers),
    signal: controller.signal,
  });
  try {
    const proxied = await handler(webRequest, { GITHUB_TOKEN: process.env.GITHUB_TOKEN });
    response.statusCode = proxied.status;
    proxied.headers.forEach((value, key) => response.setHeader(key, value));
    if (!proxied.body || method === "HEAD") {
      response.end();
      return;
    }
    await pipeProxiedBody(proxied.body, response);
  } catch (error: unknown) {
    if (!response.writableEnded) next(error);
  }
}

/** Serves `/api/github/*` through the same Worker proxy in `vite dev` and `vite preview`. */
function githubProxy(): Plugin {
  const handler = createGitHubProxy();
  const middleware: Connect.NextHandleFunction = (request, response, next) => {
    const pathname = (request.url ?? "").split("?", 1)[0] ?? "";
    if (pathname !== GITHUB_PROXY_PREFIX && !pathname.startsWith(`${GITHUB_PROXY_PREFIX}/`)) {
      next();
      return;
    }
    void handleGitHubProxy(handler, request, response, next);
  };
  return {
    name: "sprockt:github-proxy",
    configureServer: (server) => void server.middlewares.use(middleware),
    configurePreviewServer: (server) => void server.middlewares.use(middleware),
  };
}

export default defineConfig({
  plugins: [react(), crossOriginIsolation(), githubProxy(), previewScripts()],
  resolve: {
    dedupe: ["react", "react-dom", "@shaulavo/hotkeys", "@base-ui/react"],
  },
  build: { target: "esnext", sourcemap: true },
  // Each worker is one file. A split worker chunk imports back from the worker's entry file, and
  // WebKit evaluates that entry a second time instead of reusing the running one: the second copy
  // replaces the first's message handler, so in attach mode Waffle's filesystem worker answered
  // programs from an empty tree.
  worker: { format: "es", rolldownOptions: { output: { codeSplitting: false } } },
  server: { strictPort: true },
  preview: { strictPort: true },
});
