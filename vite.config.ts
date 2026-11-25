import { defineConfig, type Connect, type Plugin } from "vite";
import solid from "vite-plugin-solid";

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

export default defineConfig({
  plugins: [solid(), crossOriginIsolation()],
  build: { target: "esnext", sourcemap: true },
  // Each worker is one file. A split worker chunk imports back from the worker's entry file, and
  // WebKit evaluates that entry a second time instead of reusing the running one: the second copy
  // replaces the first's message handler, so Waffle's filesystem worker answered programs from an
  // empty tree and Bun's workers started twice.
  worker: { format: "es", rolldownOptions: { output: { codeSplitting: false } } },
  server: { strictPort: true },
  preview: { strictPort: true },
});
