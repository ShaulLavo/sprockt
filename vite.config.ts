import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { defineConfig, type Connect, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { previewScripts } from "./src/preview/vite-plugin";
import { createGitHubProxyMiddleware } from "./worker/github-proxy-middleware.ts";

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

/** Serves `/api/github/*` through the same Worker proxy in `vite dev` and `vite preview`. */
function githubProxy(): Plugin {
  const middleware = createGitHubProxyMiddleware();
  return {
    name: "sprockt:github-proxy",
    configureServer: (server) => void server.middlewares.use(middleware),
    configurePreviewServer: (server) => void server.middlewares.use(middleware),
  };
}

/** Copies `@shaulavo/workbench/THIRD_PARTY_NOTICES.txt` into every production build output. */
function copyWorkbenchNotices(): Plugin {
  return {
    name: "sprockt:workbench-notices",
    apply: "build",
    generateBundle() {
      const require = createRequire(import.meta.url);
      const noticesPath = require.resolve("@shaulavo/workbench/THIRD_PARTY_NOTICES.txt");
      const source = readFileSync(noticesPath, "utf8");
      if (source.trim().length === 0) {
        throw new Error(`Expected non-empty @shaulavo/workbench/THIRD_PARTY_NOTICES.txt at ${noticesPath}`);
      }
      this.emitFile({ type: "asset", fileName: "THIRD_PARTY_NOTICES.txt", source });
    },
  };
}

export default defineConfig({
  plugins: [react(), crossOriginIsolation(), githubProxy(), previewScripts(), copyWorkbenchNotices()],
  resolve: {
    dedupe: [
      "react",
      "react-dom",
      "@shaulavo/hotkeys",
      "@base-ui/react",
      "@singapore-editor/core",
      "ghostty-webgpu",
    ],
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
