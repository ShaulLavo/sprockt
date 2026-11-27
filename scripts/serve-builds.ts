// For the end-to-end suite only. One origin that serves any of three builds of the app, picked
// per request by a cookie: `dist` (the test build, with mounted previews) unless the cookie says
// `sprockt-build=off`, then `dist-previews-off` (a build without previews), or
// `sprockt-build=isolated`, then `dist-isolated` (a build whose previews have origins of their
// own). A fourth value, `off-old-worker`, is the build without previews whose `/preview-sw.js`
// is still the old one, as behind a cache that has not caught up: the browser then finds no
// newer worker to update to.
//
// A browser context starts on the first build, and a test moves it to another by setting the
// cookie. That is what an origin does when a new deploy goes live while tabs of the old one are
// still open, and e2e/previews-off.spec.ts tests what the new build does about the old one's
// service worker. Cookies belong to a browser context, so tests do not affect each other.
//
// The same port also answers as the preview hosts of the isolated build,
// `<id>-<port>-pv.localhost:<port>` (browsers resolve every name under `localhost` to this
// machine). Those requests go to the Worker that serves the real hosts (worker/preview.ts),
// with the files it serves read from the pinned bun-wasm package.
//
//   bun scripts/serve-builds.ts --port 4174
import { extname, join, normalize, sep } from "node:path";
import { createGitHubProxy, GITHUB_PROXY_PREFIX } from "../worker/github-proxy.ts";
import { handlePreviewHostRequest, type PreviewHostsEnv } from "../worker/preview.ts";

const githubProxy = createGitHubProxy();

export const BUILD_COOKIE = "sprockt-build";

const ROOTS = { on: "dist", off: "dist-previews-off", isolated: "dist-isolated" } as const;

/** Where the pinned bun-wasm package keeps the preview hosts' files (wrangler.preview.jsonc). */
const PREVIEW_HOST_FILES = "node_modules/bun-wasm/dist/package/preview-origin";

/** The same isolation the real hosts send (vite.config.ts, public/_headers). */
const HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cache-Control": "no-store",
};

const WORKER_PATH = "/preview-sw.js";

export type Deploy = "on" | "off" | "off-old-worker" | "isolated";

const DEPLOYS: readonly Exclude<Deploy, "on">[] = ["off", "off-old-worker", "isolated"];

/** Which deploy a request sees, from its Cookie header. */
export function deployFor(cookie: string | null): Deploy {
  const pairs = new Set((cookie ?? "").split(";").map((pair) => pair.trim()));
  return DEPLOYS.find((deploy) => pairs.has(`${BUILD_COOKIE}=${deploy}`)) ?? "on";
}

/** Which build's files answer `pathname` under a deploy. */
export function buildFor(deploy: Deploy, pathname: string): keyof typeof ROOTS {
  if (deploy === "on" || deploy === "isolated") return deploy;
  return deploy === "off-old-worker" && pathname === WORKER_PATH ? "on" : "off";
}

/**
 * The file under `root` that a URL path names, or undefined for a path that is malformed or
 * leaves the root.
 */
export function fileFor(root: string, pathname: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  const file = normalize(join(root, decoded));
  return file === root || file.startsWith(root + sep) ? file : undefined;
}

/** A path with no file extension is a page of the app, which `index.html` serves. */
export const isPage = (pathname: string): boolean => extname(pathname) === "";

/** Whether a request's host is the IDE's own name, and not a name under it. */
export const isIdeHost = (hostname: string): boolean => hostname === "localhost" || hostname === "127.0.0.1";

/** The bindings the preview hosts' Worker gets here, for the server listening on `port`. */
export function previewHostsEnv(base: string, port: number): PreviewHostsEnv {
  const files = join(base, PREVIEW_HOST_FILES);
  return {
    ASSETS: {
      async fetch(request) {
        const named = fileFor(files, new URL(request.url).pathname);
        const file = named === undefined ? undefined : Bun.file(named);
        return file && (await file.exists())
          ? new Response(file)
          : new Response("Not found\n", { status: 404 });
      },
    },
    PREVIEW_DOMAIN: `localhost:${port}`,
    IDE_ORIGINS: `http://localhost:${port}`,
  };
}

async function respond(request: Request, base: string): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === GITHUB_PROXY_PREFIX || pathname.startsWith(`${GITHUB_PROXY_PREFIX}/`)) {
    return githubProxy(request, { GITHUB_TOKEN: process.env.GITHUB_TOKEN });
  }
  const root = join(base, ROOTS[buildFor(deployFor(request.headers.get("cookie")), pathname)]);
  const named = fileFor(root, pathname);
  if (named === undefined) return new Response("Bad path\n", { status: 400, headers: HEADERS });
  const file = Bun.file(named);
  if (!isPage(pathname) && (await file.exists())) return new Response(file, { headers: HEADERS });
  if (!isPage(pathname)) return new Response("Not found\n", { status: 404, headers: HEADERS });
  // A page with a file of its own (`/preview-frame`), as the real host serves it; else the app.
  const own = Bun.file(`${named}.html`);
  const page = pathname !== "/" && (await own.exists()) ? own : Bun.file(join(root, "index.html"));
  return new Response(page, { headers: HEADERS });
}

function portArgument(): number {
  const port = Number(Bun.argv[Bun.argv.indexOf("--port") + 1]);
  if (!Number.isInteger(port) || port <= 0)
    throw new Error("Usage: bun scripts/serve-builds.ts --port <port>");
  return port;
}

if (import.meta.main) {
  const base = process.cwd();
  const missing = Object.values(ROOTS).filter((root) => !Bun.file(join(base, root, "index.html")).size);
  if (missing.length > 0) throw new Error(`Build first: ${missing.join(" and ")} has no index.html`);
  const port = portArgument();
  const hosts = previewHostsEnv(base, port);
  const server = Bun.serve({
    port,
    fetch: (request) =>
      isIdeHost(new URL(request.url).hostname)
        ? respond(request, base)
        : handlePreviewHostRequest(request, hosts),
  });
  console.log(`Serving ${Object.values(ROOTS).join(", ")} on http://localhost:${server.port}`);
}
