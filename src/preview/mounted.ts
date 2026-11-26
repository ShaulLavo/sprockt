// Previews mounted on the IDE's own origin. For trusted code only: development, the test
// build, the owner's private preview. The previewed code shares our origin, so it can read the
// IDE's storage and every other workspace's without asking anyone, and it can send a frame or
// a tab to any address of ours. Nothing here isolates a workspace, a port or the IDE from it,
// and nothing can: a build that must keep them apart uses isolated previews (transport.ts,
// kind.ts refuses a build that names a preview domain and asks for mounted previews).
//
// The service worker (sw.ts) turns a request for `/__preview/<workspace>/<port>/…` into a
// message to a tab that has that workspace open; Waffle's PreviewRouter answers it from the dev
// server's virtual connection.
import { PreviewRouter } from "waffle/browser/preview";
import type { PreviewMessage, PreviewReply } from "waffle/browser/preview-protocol";
import { activated } from "waffle/browser/service-worker";
import { isFrameMessage } from "./bridge";
import { askedWorkspace, hostAnnouncement, isHostQuery, isPreviewsOff } from "./host-protocol";
import {
  mountedPath,
  parseMountedUrl,
  PREVIEW_MODE_PATH,
  PREVIEW_PREFIX,
  SERVICE_WORKER_PATH,
  workspaceMount,
} from "./paths";
import { freshDeployYes, retiredFlag } from "./retirement";
import type { PreviewBackend, PreviewServer, PreviewTransport } from "./transport";
import { createTunnels } from "./tunnels";

/** A server as the runtime reported it, and the same server as the router was given it. */
interface Registered {
  readonly backend: PreviewBackend;
  readonly guarded: PreviewBackend;
}

export function createMountedPreviewTransport(workspace: string): PreviewTransport {
  const origin = location.origin;
  const router = new PreviewRouter({ baseURL: origin, prefix: workspaceMount(workspace) });
  const registered = new Map<number, Registered>();
  const listeners = new Set<(servers: readonly PreviewServer[]) => void>();
  const container: ServiceWorkerContainer | undefined = navigator.serviceWorker;
  // Sockets outlive the worker's check at their start, so this tab keeps asking for them
  // (tunnels.ts): nothing is passed on without a yes from the deploy asked after it arrived.
  const tunnels = createTunnels(freshDeployYes(() => fetch(PREVIEW_MODE_PATH, { cache: "no-store" })));
  let registration: ServiceWorkerRegistration | undefined;
  let ready: Promise<void> | undefined;

  /** Tells the worker that this tab hosts this workspace, so it is asked first. */
  const announceHost = () => registration?.active?.postMessage(hostAnnouncement(workspace));

  function onMessage(event: MessageEvent<unknown>): void {
    // The worker was retired, or could not confirm that previews are still on: whatever this
    // tab still carries for a page ends now, not at its next frame.
    if (isPreviewsOff(event.data)) return tunnels.revoke();
    if (isHostQuery(event.data)) return void announceHost();
    const asked = askedWorkspace(event.data);
    if (asked === undefined) return;
    // A request for another workspace is declined at once, so the worker moves on to the next
    // tab instead of waiting for this one. This routes requests to the tab that has the
    // server; it is not a boundary against previewed code (see the top of this file).
    if (asked === workspace) return router.onMessage(event as MessageEvent<PreviewMessage>);
    event.ports[0]?.postMessage({ type: "none" } satisfies PreviewReply);
    event.ports[0]?.close();
  }

  async function start(): Promise<void> {
    if (!container) throw new Error("This browser has no service workers, so previews cannot load");
    container.addEventListener("message", onMessage);
    container.startMessages();
    // A build without previews may have retired the worker on this origin earlier and left its
    // flag (retirement.ts). This build has previews, so the flag goes before the worker comes.
    await retiredFlag(globalThis.caches)
      .clear()
      .catch(() => {});
    registration = await container.register(SERVICE_WORKER_PATH, {
      scope: `${PREVIEW_PREFIX}/`,
      updateViaCache: "none",
    });
    await activated(registration);
    announceHost();
  }

  const servers = (): PreviewServer[] =>
    Array.from(registered.keys(), (port) => ({ port })).sort((a, b) => a.port - b.port);

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
    takesCommands: true,
    // The server sees a loopback Host here, which every dev server accepts.
    serverEnv: {},
    whenReady: () => (ready ??= start()),
    register(port, backend) {
      const guarded = tunnels.guard(backend);
      registered.set(port, { backend, guarded });
      router.register(port, guarded);
      announce();
    },
    unregister(port, backend) {
      const entry = registered.get(port);
      if (entry?.backend !== backend) return;
      registered.delete(port);
      router.unregister(port, entry.guarded);
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
    watch(frame, listener) {
      // A mounted page shares the IDE's origin, so that is the only origin heard.
      const hear = (event: MessageEvent<unknown>): void => {
        if (event.source !== frame.contentWindow || event.origin !== origin) return;
        if (isFrameMessage(event.data)) listener(event.data);
      };
      addEventListener("message", hear);
      return () => removeEventListener("message", hear);
    },
    onReloadNeeded: () => () => {},
    async dispose() {
      container?.removeEventListener("message", onMessage);
      listeners.clear();
      tunnels.revoke();
      for (const [port, entry] of registered) router.unregister(port, entry.guarded);
      registered.clear();
    },
  };
}
