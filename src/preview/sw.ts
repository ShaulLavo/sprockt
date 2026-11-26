// The preview service worker, registered for `/__preview/`. It answers requests for
// `/__preview/<workspace>/<port>/…`, and every request a previewed page makes on our origin, by
// asking a tab that has that workspace open. Waffle does the routing; this file sets our
// policy: which tabs may answer, what is added to HTML, and the isolation headers.
import { createPreviewServiceWorker, type PreviewClient } from "waffle/browser/service-worker";
import { HOST_QUERY, isHostAnnouncement, isPreviewsOff, type HostAsk } from "./host-protocol";
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
} from "./paths";
import { createRetirement, retiredFlag } from "./retirement";

declare const self: ServiceWorkerGlobalScope;

type Router = ReturnType<typeof createPreviewServiceWorker>;

/**
 * A redirect to `/login`, or to `../login`, means a place on the server. Followed as the server
 * wrote it, the browser would leave the mount, for the IDE's own page or another server's
 * mount, so it is rewritten to the same place under this server's mount.
 */
function keepRedirectMounted(response: Response, asked: MountedLocation): Response {
  const location = response.headers.get("location");
  if (location === null) return response;
  const mounted = mountedRedirect(asked.workspace, asked.port, location, asked.path);
  if (mounted === undefined) return response;
  const headers = new Headers(response.headers);
  headers.set("location", mounted);
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

/** A request a previewed page made for a path outside its mount, such as `/@vite/client`. */
async function fromPreviewPage(request: Request, clientId: string): Promise<Response> {
  const client = await self.clients.get(clientId);
  const workspace = client && workspaceOfPath(new URL(client.url).pathname);
  const routed = workspace ? routerFor(workspace).fetch(request, clientId) : undefined;
  return routed ?? fetch(request);
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
  fetchMode: () => fetch(PREVIEW_MODE_PATH, { cache: "no-store" }),
  unregister: () => self.registration.unregister(),
});

async function retire(): Promise<void> {
  routers.clear();
  hosts.clear();
  await retirement.retire();
}

/**
 * Answers a request from the workspace, unless this worker is retired or the deploy no longer
 * has previews: then the request goes to the network like any page's.
 */
async function answer(request: Request, clientId: string, workspace: string | undefined): Promise<Response> {
  // A navigation asks the deploy now: it is what would show a page that should be gone.
  if (!(await retirement.allowed(request.mode === "navigate"))) return fetch(request);
  const routed = workspace ? routerFor(workspace).fetch(request, clientId) : undefined;
  if (!routed) return clientId ? fromPreviewPage(request, clientId) : fetch(request);
  const asked = parseMountedUrl(request.url, location.origin);
  const response = await routed;
  return asked ? keepRedirectMounted(response, asked) : response;
}

/** Hands a previewed page's socket to its server, or refuses it as a closed port would. */
async function connect(socket: MessagePort, port: number, pageUrl: string): Promise<void> {
  const workspace = workspaceOfPath(new URL(pageUrl).pathname);
  const allowed = workspace !== undefined && (await retirement.allowed(false));
  const routed = allowed ? routerFor(workspace).socket(port, pageUrl, socket) : undefined;
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
  if (workspace || event.clientId) event.respondWith(answer(event.request, event.clientId, workspace));
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
