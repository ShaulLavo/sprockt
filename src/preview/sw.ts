// The preview service worker, registered for `/__preview/`. It answers requests for
// `/__preview/<workspace>/<port>/…`, and every request a previewed page makes on our origin, by
// asking a tab that has that workspace open. Waffle does the routing; this file sets our
// policy: which tabs may answer, what is added to HTML, and the isolation headers.
//
// For trusted code only (mounted.ts). The checks on who asks for what (boundary.ts) and on
// where redirects lead are defence in depth: they do not isolate a workspace, a port or the
// IDE from a previewed page, which shares their origin.
import { createPreviewServiceWorker, type PreviewClient } from "waffle/browser/service-worker";
import { routeRequest, socketAllowed } from "./boundary";
import { HOST_QUERY, isHostAnnouncement, isPreviewsOff, PREVIEWS_OFF, type HostAsk } from "./host-protocol";
import { clientScriptTag, injectTag, isHtml, isUtf8 } from "./html";
import { isolationHeaders } from "./isolation";
import {
  CLIENT_SCRIPT_PATH,
  mountedRedirect,
  parseMountedUrl,
  PREVIEW_MODE_PATH,
  workspaceMount,
  workspaceOfPath,
  type MountedLocation,
  type PreviewHome,
} from "./paths";
import { createRetirement, retiredFlag } from "./retirement";

declare const self: ServiceWorkerGlobalScope;

type Router = ReturnType<typeof createPreviewServiceWorker>;

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const REFUSAL_BODY = "403\n";

/** The answer to what a previewed page may not have: another server's mount, or a way to one. */
function refused(): Response {
  const headers = new Headers({ "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  // The body is the bare status and no sentence (copy.ts has none for this yet). It is not
  // empty, because Firefox shows a page of its own in place of an error answer without a body.
  return new Response(REFUSAL_BODY, { status: 403, headers: isolationHeaders(headers) });
}

/**
 * A redirect to `/login`, or to `../login`, means a place on the server. Followed as the server
 * wrote it, the browser would leave the mount, for the IDE's own page or another server's
 * mount, so it is rewritten to the same place under this server's mount. A redirect that names
 * another server of the workspace is not passed on at all (`mountedRedirect`). `home` is the
 * server that answered and `from` the path it was asked for.
 */
function keepRedirectMounted(response: Response, home: PreviewHome, from: string): Response {
  const location = response.headers.get("location");
  if (location === null) return response;
  const rule = mountedRedirect(home, location, from, self.location.origin);
  if (rule.action === "keep") return response;
  // Only a redirect sends the browser anywhere; any other response keeps its header.
  if (rule.action === "refuse") return REDIRECTS.has(response.status) ? refused() : response;
  const headers = new Headers(response.headers);
  headers.set("location", rule.location);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function transformResponse(workspace: string, response: Response, port: number): Response {
  const headers = isolationHeaders(new Headers(response.headers));
  const type = headers.get("content-type");
  const inject = response.body && isHtml(type) && isUtf8(type);
  const body = inject
    ? response.body.pipeThrough(injectTag(clientScriptTag(workspace, port)))
    : response.body;
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * Which workspace each tab said it hosts (see `announce` in mounted.ts). It only decides whom
 * to ask first: a service worker is stopped when idle and starts again with this map empty.
 */
const hosts = new Map<string, string>();

/**
 * The tabs to ask for a workspace's server. Every request carries the workspace, and a tab
 * answers only for its own (mounted.ts), so a tab of another workspace that happens to run a
 * server on the same port can never answer. Tabs known to host this workspace are asked
 * first; tabs known to host another one are not asked at all.
 */
async function hostTabs(workspace: string): Promise<PreviewClient[]> {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const open = new Set(windows.map((client) => client.id));
  for (const id of hosts.keys()) if (!open.has(id)) hosts.delete(id);
  const known = windows.filter((client) => hosts.get(client.id) === workspace);
  const candidates = known.length > 0 ? known : windows.filter((client) => !hosts.has(client.id));
  return candidates.map((client) => ({
    url: client.url,
    postMessage: (message, transfer) =>
      client.postMessage({ ...message, workspace } satisfies HostAsk, transfer),
  }));
}

const routers = new Map<string, Router>();

/** One Waffle router per workspace, scoped to that workspace's directory. */
function routerFor(workspace: string): Router {
  const existing = routers.get(workspace);
  if (existing) return existing;
  const created = createPreviewServiceWorker({
    scope: new URL(`${workspaceMount(workspace)}/`, location.origin).href,
    clients: { get: (id) => self.clients.get(id), matchAll: () => hostTabs(workspace) },
    fetch: (request) => fetch(request),
    transformResponse: (response, port) => transformResponse(workspace, response, port),
  });
  routers.set(workspace, created);
  return created;
}

/**
 * The previewed page a request comes from, as a place in a mount, or undefined when no such
 * page is behind it. A page's own requests name it as their client. A page load has no client
 * yet; the page that started it is its referrer, when it sent one.
 */
async function sourceOf(request: Request, clientId: string): Promise<MountedLocation | undefined> {
  if (request.mode === "navigate") return parseMountedUrl(request.referrer, location.origin);
  const client = clientId ? await self.clients.get(clientId) : undefined;
  return client ? parseMountedUrl(client.url, location.origin) : undefined;
}

/** A request a previewed page made for a path outside its mount, such as `/@vite/client`. */
async function fromOwnServer(request: Request, clientId: string, home: MountedLocation): Promise<Response> {
  const routed = clientId ? routerFor(home.workspace).fetch(request, clientId) : undefined;
  if (!routed) return fetch(request);
  const url = new URL(request.url);
  return keepRedirectMounted(await routed, home, `${url.pathname}${url.search}`);
}

/** Asks every open tab which workspace it hosts: this worker has just started and knows none. */
async function askHosts(): Promise<void> {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  // A service worker's client takes no target origin: it is one tab of our own origin.
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  for (const client of windows) client.postMessage({ type: HOST_QUERY });
}

/**
 * Whether this worker may answer at all (retirement.ts). Nothing about that is kept in memory
 * alone: the browser stops and restarts a worker at will, and a restarted worker reads the
 * retired flag and asks the deploy again before it serves anything.
 */
const retirement = createRetirement({
  flag: retiredFlag(self.caches),
  fetchMode: (signal) => fetch(PREVIEW_MODE_PATH, { cache: "no-store", signal }),
  unregister: () => self.registration.unregister(),
});

/**
 * Tells every open tab that the workspace is not served now. A tab that runs a server ends the
 * sockets and responses it still carries for previewed pages (tunnels.ts): this worker handed
 * those over when they started and cannot reach them any more.
 */
async function tellTabsToStop(): Promise<void> {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  // A service worker's client takes no target origin: it is one tab of our own origin.
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  for (const client of windows) client.postMessage({ type: PREVIEWS_OFF });
}

async function retire(): Promise<void> {
  routers.clear();
  hosts.clear();
  await retirement.retire();
  await tellTabsToStop();
}

/**
 * Whether the workspace may answer now (retirement.ts). When it may not, because previews are
 * gone or because nobody can say that they are still on, the tabs are told as well.
 */
async function mayServe(navigation: boolean): Promise<boolean> {
  const allowed = await retirement.allowed(navigation);
  if (!allowed) await tellTabsToStop();
  return allowed;
}

/**
 * Answers a request from the workspace, unless this worker is retired or the deploy no longer
 * has previews: then the request goes to the network like any page's.
 */
async function answer(request: Request, clientId: string): Promise<Response> {
  // The deploy is asked for every request: a page that is still open gets nothing more from
  // the workspace once previews are gone, or while nobody can say that they are still on.
  if (!(await mayServe(request.mode === "navigate"))) return fetch(request);
  // The page that asks decides which server answers, not the address it asks for (boundary.ts).
  const route = routeRequest(request.url, location.origin, await sourceOf(request, clientId));
  if (route.to === "network") return fetch(request);
  if (route.to === "refuse") return refused();
  if (route.to === "own") return fromOwnServer(request, clientId, route.home);
  const routed = routerFor(route.place.workspace).fetch(request, clientId);
  return routed ? keepRedirectMounted(await routed, route.place, route.place.path) : fetch(request);
}

/** Hands a previewed page's socket to its own server, or refuses it as a closed port would. */
async function connect(socket: MessagePort, port: number, pageUrl: string): Promise<void> {
  const page = socketAllowed(pageUrl, location.origin, port);
  const allowed = page !== undefined && (await mayServe(false));
  const routed = allowed ? routerFor(page.workspace).socket(port, pageUrl, socket) : undefined;
  if (routed) return routed;
  // A message port has no target origin: it reaches its other end only.
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  socket.postMessage({ type: "error" });
  socket.close();
}

self.addEventListener("install", () => void self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
void askHosts();

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Our own files are real files; everything else a preview asks for is its server's.
  const ownFile = url.pathname === CLIENT_SCRIPT_PATH || url.pathname === PREVIEW_MODE_PATH;
  if (url.origin !== location.origin || ownFile) return;
  const workspace = workspaceOfPath(url.pathname);
  if (workspace || event.clientId) event.respondWith(answer(event.request, event.clientId));
});

/** A previewed page opens a WebSocket by handing us one end of a channel to its server. */
self.addEventListener("message", (event) => {
  const socket = event.ports[0];
  const source = event.source;
  const data: unknown = event.data;
  if (isPreviewsOff(data)) return void event.waitUntil(retire());
  if (!source || !("url" in source)) return;
  if (isHostAnnouncement(data)) return void hosts.set(source.id, data.workspace);
  if (!socket) return;
  if (!data || typeof data !== "object" || !("type" in data) || data.type !== "preview-socket") return;
  if (!("port" in data) || typeof data.port !== "number") return;
  event.waitUntil(connect(socket, data.port, source.url));
});
