// For the end-to-end suite only. One origin that serves either of two builds of the app, picked
// per request by a cookie: `dist` (the test build, with previews) unless the cookie says
// `sprockt-build=off`, then `dist-previews-off` (a build without them). A third value,
// `off-old-worker`, is the build without previews whose `/preview-sw.js` is still the old one,
// as behind a cache that has not caught up: the browser then finds no newer worker to update to.
//
// A browser context starts on the first build, and a test moves it to the second by setting the
// cookie. That is what an origin does when a new deploy goes live while tabs of the old one are
// still open, and e2e/previews-off.spec.ts tests what the new build does about the old one's
// service worker. Cookies belong to a browser context, so tests do not affect each other.
//
//   bun scripts/serve-builds.ts --port 4174
import { extname, join, normalize, sep } from "node:path";

export const BUILD_COOKIE = "sprockt-build";

const ROOTS = { on: "dist", off: "dist-previews-off" } as const;

/** The same isolation the real hosts send (vite.config.ts, public/_headers). */
const HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cache-Control": "no-store",
};

const WORKER_PATH = "/preview-sw.js";

export type Deploy = "on" | "off" | "off-old-worker";

/** Which deploy a request sees, from its Cookie header. */
export function deployFor(cookie: string | null): Deploy {
  const pairs = new Set((cookie ?? "").split(";").map((pair) => pair.trim()));
  if (pairs.has(`${BUILD_COOKIE}=off`)) return "off";
  return pairs.has(`${BUILD_COOKIE}=off-old-worker`) ? "off-old-worker" : "on";
}

/** Which build's files answer `pathname` under a deploy. */
export function buildFor(deploy: Deploy, pathname: string): keyof typeof ROOTS {
  if (deploy === "on") return "on";
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

async function respond(request: Request, base: string): Promise<Response> {
  const { pathname } = new URL(request.url);
  const root = join(base, ROOTS[buildFor(deployFor(request.headers.get("cookie")), pathname)]);
  const named = fileFor(root, pathname);
  if (named === undefined) return new Response("Bad path\n", { status: 400, headers: HEADERS });
  const file = Bun.file(named);
  if (!isPage(pathname) && (await file.exists())) return new Response(file, { headers: HEADERS });
  if (!isPage(pathname)) return new Response("Not found\n", { status: 404, headers: HEADERS });
  return new Response(Bun.file(join(root, "index.html")), { headers: HEADERS });
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
  const server = Bun.serve({ port: portArgument(), fetch: (request) => respond(request, base) });
  console.log(`Serving ${ROOTS.on} and ${ROOTS.off} on http://localhost:${server.port}`);
}
