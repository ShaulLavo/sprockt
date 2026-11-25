// Previews mounted on the IDE's own origin, for development builds only: the previewed code
// shares our origin and could reach the IDE's storage (see transport.ts).
//
// The service worker (sw.ts) turns a request for `/__preview/<workspace>/<port>/…` into a
// message to a tab that has that workspace open; Waffle's PreviewRouter answers it from the dev
// server's virtual connection.
import { PreviewRouter } from "waffle/browser/preview";
import type { PreviewMessage, PreviewReply } from "waffle/browser/preview-protocol";
import { activated } from "waffle/browser/service-worker";
import { askedWorkspace, hostAnnouncement, isHostQuery } from "./host-protocol";
import { mountedPath, parseMountedUrl, PREVIEW_PREFIX, SERVICE_WORKER_PATH, workspaceMount } from "./paths";
import type { PreviewBackend, PreviewServer, PreviewTransport } from "./transport";

export function createMountedPreviewTransport(workspace: string): PreviewTransport {
  const origin = location.origin;
  const router = new PreviewRouter({ baseURL: origin, prefix: workspaceMount(workspace) });
  const backends = new Map<number, PreviewBackend>();
  const listeners = new Set<(servers: readonly PreviewServer[]) => void>();
  const container: ServiceWorkerContainer | undefined = navigator.serviceWorker;
  let registration: ServiceWorkerRegistration | undefined;
  let ready: Promise<void> | undefined;

  /** Tells the worker that this tab hosts this workspace, so it is asked first. */
  const announceHost = () => registration?.active?.postMessage(hostAnnouncement(workspace));

  function onMessage(event: MessageEvent<unknown>): void {
    if (isHostQuery(event.data)) return void announceHost();
    const asked = askedWorkspace(event.data);
    if (asked === undefined) return;
    // A request for another workspace is declined at once, so the worker moves on to the next
    // tab instead of waiting for this one. This check is what keeps workspaces apart.
    if (asked === workspace) return router.onMessage(event as MessageEvent<PreviewMessage>);
    event.ports[0]?.postMessage({ type: "none" } satisfies PreviewReply);
    event.ports[0]?.close();
  }

  async function start(): Promise<void> {
    if (!container) throw new Error("This browser has no service workers, so previews cannot load");
    container.addEventListener("message", onMessage);
    container.startMessages();
    registration = await container.register(SERVICE_WORKER_PATH, {
      scope: `${PREVIEW_PREFIX}/`,
      updateViaCache: "none",
    });
    await activated(registration);
    announceHost();
  }

  const servers = (): PreviewServer[] =>
    Array.from(backends.keys(), (port) => ({ port })).sort((a, b) => a.port - b.port);

  function announce(): void {
    const current = servers();
    for (const listener of listeners) listener(current);
  }

  function locate(href: string) {
    const place = parseMountedUrl(href, origin);
    return place?.workspace === workspace ? { port: place.port, path: place.path } : undefined;
  }

  return {
    kind: "mounted",
    whenReady: () => (ready ??= start()),
    register(port, backend) {
      backends.set(port, backend);
      router.register(port, backend);
      announce();
    },
    unregister(port, backend) {
      if (backends.get(port) !== backend) return;
      backends.delete(port);
      router.unregister(port, backend);
      announce();
    },
    servers,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    frameUrl: (port, path) => origin + mountedPath(workspace, port, path),
    tabUrl: (port, path) => origin + mountedPath(workspace, port, path),
    locate,
    ownsOrigin: (candidate) => candidate === origin,
    onReloadNeeded: () => () => {},
    async dispose() {
      container?.removeEventListener("message", onMessage);
      listeners.clear();
      for (const [port, backend] of backends) router.unregister(port, backend);
      backends.clear();
    },
  };
}
