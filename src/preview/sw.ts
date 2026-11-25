// The preview service worker, registered for `/__preview/`. It answers requests for
// `/__preview/<workspace>/<port>/…`, and every request a previewed page makes on our origin, by
// asking a tab that has that workspace open. Waffle does the routing; this file sets our
// policy: which tabs may answer, what is added to HTML, and the isolation headers.
import { createPreviewServiceWorker, type PreviewClient } from "waffle/browser/service-worker";
import { HOST_QUERY, isHostAnnouncement, type HostAsk } from "./host-protocol";
import { clientScriptTag, injectTag, isHtml, isUtf8 } from "./html";
import { CLIENT_SCRIPT_PATH, serverMount, workspaceMount, workspaceOfPath } from "./paths";

declare const self: ServiceWorkerGlobalScope;

type Router = ReturnType<typeof createPreviewServiceWorker>;

/** The IDE is cross-origin isolated, so a framed preview document has to opt in as well. */
function isolated(headers: Headers): Headers {
  if (!headers.has("cross-origin-embedder-policy"))
    headers.set("cross-origin-embedder-policy", "require-corp");
  if (!headers.has("cross-origin-resource-policy"))
    headers.set("cross-origin-resource-policy", "same-origin");
  return headers;
}

/**
 * A redirect to `/login` means the server's `/login`. Followed as it is, the browser would
 * leave the mount and load the IDE's own page, so the mount is put in front.
 */
function mountRedirect(headers: Headers, mount: string): void {
  const location = headers.get("location");
  const absolute = location?.startsWith("/") && !location.startsWith("//");
  if (location && absolute && !location.startsWith(`${mount}/`)) headers.set("location", mount + location);
}

function transformResponse(workspace: string, response: Response, port: number): Response {
  const headers = isolated(new Headers(response.headers));
  mountRedirect(headers, serverMount(workspace, port));
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

self.addEventListener("install", () => void self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
void askHosts();

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Our own client script is a real file; everything else a preview asks for is the server's.
  if (url.origin !== location.origin || url.pathname === CLIENT_SCRIPT_PATH) return;
  const workspace = workspaceOfPath(url.pathname);
  const routed = workspace ? routerFor(workspace).fetch(event.request, event.clientId) : undefined;
  if (routed) event.respondWith(routed);
  else if (event.clientId) event.respondWith(fromPreviewPage(event.request, event.clientId));
});

/** A previewed page opens a WebSocket by handing us one end of a channel to its server. */
self.addEventListener("message", (event) => {
  const socket = event.ports[0];
  const source = event.source;
  const data: unknown = event.data;
  if (!source || !("url" in source)) return;
  if (isHostAnnouncement(data)) return void hosts.set(source.id, data.workspace);
  if (!socket) return;
  if (!data || typeof data !== "object" || !("type" in data) || data.type !== "preview-socket") return;
  if (!("port" in data) || typeof data.port !== "number") return;
  const workspace = workspaceOfPath(new URL(source.url).pathname);
  const routed = workspace ? routerFor(workspace).socket(data.port, source.url, socket) : undefined;
  if (routed) event.waitUntil(routed);
});
