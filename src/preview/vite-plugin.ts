// Builds the two preview scripts that cannot be ordinary chunks. The service worker has to sit
// at a fixed path above its scope, and both it and the client script must be classic scripts:
// module service workers are not available in every browser we support, and the client script
// has to run before the previewed page's own scripts.
import { resolve } from "node:path";
import { build, type Plugin } from "vite";
import { CLIENT_SCRIPT_PATH, SERVICE_WORKER_PATH } from "./paths";

const ENTRIES: Readonly<Record<string, string>> = {
  [SERVICE_WORKER_PATH]: "src/preview/sw.ts",
  [CLIENT_SCRIPT_PATH]: "src/preview/inject/client.ts",
};

async function bundle(root: string, entry: string, minify: boolean): Promise<string> {
  const result = await build({
    configFile: false,
    root,
    logLevel: "warn",
    build: {
      write: false,
      target: "esnext",
      minify,
      lib: { entry: resolve(root, entry), formats: ["iife"], name: "sprocktPreview" },
    },
  });
  const [output] = Array.isArray(result) ? result : [result];
  const chunk = output && "output" in output ? output.output[0] : undefined;
  if (!chunk) throw new Error(`Building ${entry} produced no output`);
  return chunk.code;
}

export function previewScripts(): Plugin {
  let root = process.cwd();
  const cache = new Map<string, Promise<string>>();
  return {
    name: "sprockt:preview-scripts",
    configResolved(config) {
      root = config.root;
    },
    async generateBundle() {
      const paths = Object.keys(ENTRIES);
      const sources = await Promise.all(paths.map((path) => bundle(root, ENTRIES[path] ?? "", true)));
      for (const [index, path] of paths.entries()) {
        this.emitFile({ type: "asset", fileName: path.slice(1), source: sources[index] ?? "" });
      }
    },
    configureServer(server) {
      server.watcher.on("change", () => cache.clear());
      server.middlewares.use((request, response, next) => {
        const path = request.url?.split("?")[0] ?? "";
        const entry = ENTRIES[path];
        if (!entry) return next();
        const built = cache.get(path) ?? bundle(root, entry, false);
        cache.set(path, built);
        const send = (code: string): void => {
          response.setHeader("content-type", "text/javascript");
          response.setHeader("cache-control", "no-store");
          response.end(code);
        };
        // Connect reports errors through its `next` callback; there is no promise to return.
        // oxlint-disable-next-line promise/no-callback-in-promise
        built.then(send).catch(next);
      });
    },
  };
}
