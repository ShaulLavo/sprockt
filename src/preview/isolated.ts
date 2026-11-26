// Previews on origins of their own, for public builds: `<id>-<port>-pv.<domain>` for every
// listening port of a workspace. The previewed code shares nothing with the IDE's origin: not
// its storage, not its cookies, not its service workers.
//
// bun-wasm's `RootPreviews` does the carrying. This tab mounts one hidden relay frame per
// preview origin; the service worker of that origin sends every request of the app over a
// MessagePort to the tab that runs the server (bun-wasm `docs/preview-origins.md`). The preview
// hosts themselves serve four fixed files and nothing else (worker/preview-hosts.ts).
import {
  previewHostEnv,
  previewOriginId,
  RootPreviews,
  type PreviewOriginConfig,
} from "bun-wasm/preview-origins";
import {
  createRetries,
  framePage,
  placeReport,
  previewOrigins,
  type PreviewOrigins,
} from "./isolated-origins";
import type { PreviewBackend, PreviewServer, PreviewTransport } from "./transport";

export interface IsolatedPreviewOptions {
  /** The domain every preview host ends with: `sprockt.dev`, or `localhost:<port>` in tests. */
  readonly domain: string;
  /** The workspace's preview identity (identity.ts). Asked for once, when it is first needed. */
  identity(): Promise<string>;
}

export function createIsolatedPreviewTransport(options: IsolatedPreviewOptions): PreviewTransport {
  const config: PreviewOriginConfig = { domain: options.domain };
  const ideOrigin = location.origin;
  /** Servers of this tab whose origin is attached, so a frame can load them. */
  const listed = new Map<number, PreviewBackend>();
  const listeners = new Set<(servers: readonly PreviewServer[]) => void>();
  let identity: Promise<string> | undefined;
  let origins: PreviewOrigins | undefined;
  let disposed = false;

  /** Read once and shared by everything that needs it. A read that failed is tried again. */
  function readIdentity(): Promise<string> {
    if (disposed) return Promise.reject(new Error("The previews of this workspace were closed"));
    const reading = (identity ??= options.identity());
    reading.catch(() => {
      if (identity === reading) identity = undefined;
    });
    return reading;
  }

  async function name(): Promise<void> {
    if (origins) return;
    const id = await previewOriginId(ideOrigin, await readIdentity());
    origins = previewOrigins(config, id);
  }

  /** The workspace's names. They exist once `whenReady` resolved, which the pane waits for. */
  function named(): PreviewOrigins {
    if (!origins) throw new Error("The preview's addresses are asked for before the transport is ready");
    return origins;
  }

  const previews = new RootPreviews({
    config,
    identity: readIdentity,
    persistCookies: true,
    ideOrigin,
    frameLink: (url) => framePage(ideOrigin, url),
  });

  const servers = (): PreviewServer[] =>
    Array.from(listed.keys(), (port) => ({ port })).sort((a, b) => a.port - b.port);

  function announce(): void {
    const current = servers();
    for (const listener of listeners) listener(current);
  }

  /** Lists a server once its origin's service worker has the connection to it. */
  async function list(port: number, backend: PreviewBackend, token: symbol): Promise<void> {
    const state = await previews.waitUntilRegistered(port, token);
    // Stopped, or replaced by a later server on the port, while its origin was being attached.
    if (!previews.hasListener(port, token)) return;
    // Still listed: the frame then shows what the browser makes of the origin, and the reason
    // (preview hosts that do not resolve, a blocked service worker) is on the console.
    if (state !== "ready") console.error(`The preview origin of port ${port} could not be attached`);
    listed.set(port, backend);
    announce();
  }

  function watch(frame: HTMLIFrameElement, listener: Parameters<PreviewTransport["watch"]>[1]): () => void {
    const retries = createRetries();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const again = (): void => {
      // Assigning the address again loads it again.
      // oxlint-disable-next-line no-self-assign
      frame.src = frame.src;
    };
    /** The origin's worker answered in the server's place; `transient` says a retry may help. */
    function unanswered(transient: boolean): void {
      const delay = retries.unanswered(frame.src, transient);
      if (delay === undefined) return;
      clearTimeout(timer);
      timer = setTimeout(again, delay);
    }
    const stop = previews.observeFrame(frame, (message) => {
      const report = placeReport(message);
      if (!report) return unanswered(message.transient === true);
      retries.answered();
      listener(report);
    });
    return () => {
      clearTimeout(timer);
      stop();
    };
  }

  return {
    kind: "isolated",
    // The page's script is the preview origin's own, not ours: it reports, and takes no commands.
    takesCommands: false,
    serverEnv: previewHostEnv(config),
    async whenReady() {
      if (!navigator.serviceWorker)
        throw new Error("This browser has no service workers, so previews cannot load");
      await name();
    },
    register(port, backend) {
      const token = previews.registerListener(port, backend);
      list(port, backend, token).catch((error: unknown) =>
        console.error(`Listing the preview of port ${port} failed`, error),
      );
    },
    unregister(port, backend) {
      previews.unregister(port, backend);
      if (listed.get(port) !== backend) return;
      listed.delete(port);
      announce();
    },
    servers,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    frameUrl: (port, path) => named().url(port, path),
    tabUrl: (port, path) => framePage(ideOrigin, named().url(port, path)),
    locate: (href) => origins?.locate(href),
    watch,
    onReloadNeeded: () => () => {},
    async dispose() {
      disposed = true;
      listeners.clear();
      listed.clear();
      await previews.dispose();
      // A claim that is still out is stored before this resolves, and the tab lets go of the
      // workspace's storage only after it (session.ts): no claim can land after a deletion.
      await identity?.catch(() => undefined);
    },
  };
}
