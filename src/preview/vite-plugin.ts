// Builds the two preview scripts that cannot be ordinary chunks. The service worker has to sit
// at a fixed path above its scope, and both it and the client script must be classic scripts:
// module service workers are not available in every browser we support, and the client script
// has to run before the previewed page's own scripts.
//
// A build without mounted previews (none at all, or isolated ones) publishes neither. In the
// worker's place it puts one that serves nothing and removes itself (sw-off.ts), for browsers
// that still hold an earlier build's worker.
import { resolve } from "node:path";
import { build, type Plugin } from "vite";
//
// A build with mounted previews also publishes `/preview-mode.json`, which says so. The service
// worker asks for it to learn whether the deployed build still has them (retirement.ts); a
// build without them has no such file.
//
// A build with isolated previews publishes the page that shows one in a tab of its own
// (`/preview-frame`, frame-page-html.ts) and its script, built the same way: one classic script
// that shares no chunk with the app, so the app's own page loads what it always loaded.
import { framePageHtml } from "./frame-page-html";
import { previewDomain, previewKind, type PreviewKind } from "./kind";
import {
  CLIENT_SCRIPT_PATH,
  FRAME_PAGE_PATH,
  FRAME_PAGE_SCRIPT_PATH,
  PREVIEW_MODE_PATH,
  SERVICE_WORKER_PATH,
} from "./paths";
import { MOUNTED_MODE } from "./retirement";

type Entries = Readonly<Record<string, string>>;

const ENTRIES: Entries = {
  [SERVICE_WORKER_PATH]: "src/preview/sw.ts",
  [CLIENT_SCRIPT_PATH]: "src/preview/inject/client.ts",
};

const ENTRIES_OFF: Entries = { [SERVICE_WORKER_PATH]: "src/preview/sw-off.ts" };

/** Isolated previews: the page that shows one in a tab of its own has one script. */
const ENTRIES_ISOLATED: Entries = { ...ENTRIES_OFF, [FRAME_PAGE_SCRIPT_PATH]: "src/preview/frame-page.ts" };

const MODE_FILE = `${JSON.stringify(MOUNTED_MODE)}\n`;

/**
 * What a build publishes at the preview scripts' addresses. Only mounted previews have a
 * service worker of ours: isolated ones are served by their own hosts, so a build with them
 * takes the mounted worker down exactly as a build with no previews does.
 */
export function publishedEntries(kind: PreviewKind): Entries {
  if (kind === "mounted") return ENTRIES;
  return kind === "isolated" ? ENTRIES_ISOLATED : ENTRIES_OFF;
}

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
  const files = output && "output" in output ? output.output : [];
  // Each script is one file: a second chunk would be dropped here, and a split worker entry is
  // evaluated twice by WebKit (see `worker` in vite.config.ts).
  if (files.length !== 1) throw new Error(`Building ${entry} produced ${files.length} files, not one`);
  return files[0].code;
}

export function previewScripts(): Plugin {
  let root = process.cwd();
  let kind: PreviewKind = "none";
  let domain: string | undefined;
  const cache = new Map<string, Promise<string>>();
  return {
    name: "sprockt:preview-scripts",
    configResolved(config) {
      root = config.root;
      // The same rule, from the same settings, as the app's own `import.meta.env` check.
      const settings = {
        DEV: config.env.DEV === true,
        VITE_SPROCKT_PREVIEWS: config.env.VITE_SPROCKT_PREVIEWS,
        VITE_SPROCKT_PREVIEW_DOMAIN: config.env.VITE_SPROCKT_PREVIEW_DOMAIN,
      };
      // A malformed domain fails the build here, not in a visitor's browser.
      domain = previewDomain(settings);
      kind = previewKind(settings);
    },
    async generateBundle() {
      const published = publishedEntries(kind);
      const paths = Object.keys(published);
      const sources = await Promise.all(paths.map((path) => bundle(root, published[path] ?? "", true)));
      for (const [index, path] of paths.entries()) {
        this.emitFile({ type: "asset", fileName: path.slice(1), source: sources[index] ?? "" });
      }
      if (kind === "mounted")
        this.emitFile({ type: "asset", fileName: PREVIEW_MODE_PATH.slice(1), source: MODE_FILE });
      // The page is a file of its own name, which the hosts serve at `/preview-frame`.
      if (kind === "isolated" && domain)
        this.emitFile({
          type: "asset",
          fileName: `${FRAME_PAGE_PATH.slice(1)}.html`,
          source: framePageHtml(domain),
        });
    },
    configureServer(server) {
      server.watcher.on("change", () => cache.clear());
      server.middlewares.use((request, response, next) => {
        const path = request.url?.split("?")[0] ?? "";
        // The dev server always has previews.
        if (path === PREVIEW_MODE_PATH) {
          response.setHeader("content-type", "application/json");
          response.setHeader("cache-control", "no-store");
          return void response.end(MODE_FILE);
        }
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
