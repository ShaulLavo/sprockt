// The seam between the preview pane and whatever carries a dev server's responses to a frame.
// The pane only ever asks this interface for URLs.
//
// A transport belongs to one workspace, and every route it builds is keyed by that workspace
// and the port, never by the port alone: two workspaces with a server on the same port must
// not receive each other's HTTP or WebSocket traffic.
//
// `mounted` serves `/__preview/<workspace>/<port>/` on the IDE's own origin through a service
// worker. The previewed code then shares the IDE's origin and can reach its storage, so
// `mounted` is a development stopgap for trusted local projects and is never in a public
// build. `isolated` gives each server an origin of its own (`<id>-<port>-pv.sprockt.dev`);
// that is what keeps a previewed project away from the IDE, and it is required before any
// public deploy.
import type { PreviewServer as PreviewBackend } from "waffle/browser/preview";

export type { PreviewBackend };

export interface PreviewServer {
  /** The port the dev server listens on inside the workspace. */
  readonly port: number;
  /** What the port picker shows, for example "vite" or "bun". */
  readonly label?: string;
}

/** Where a frame currently is, as far as its transport can tell. */
export interface PreviewPlace {
  readonly port: number;
  /** Path, query and hash on the dev server. */
  readonly path: string;
}

export interface PreviewTransport {
  readonly kind: "none" | "mounted" | "isolated";
  /** Resolves when frames can load. Rejects when previews cannot work in this browser. */
  whenReady(): Promise<void>;
  /** The runtime reports a listening port and the connection to it; `unregister` when it stops. */
  register(port: number, backend: PreviewBackend): void;
  unregister(port: number, backend: PreviewBackend): void;
  /** Servers that are listening right now, lowest port first. */
  servers(): readonly PreviewServer[];
  /** Calls back with the full list whenever a server starts or stops. Returns the unsubscribe. */
  subscribe(listener: (servers: readonly PreviewServer[]) => void): () => void;
  /** The URL the preview frame loads for `path` (with query and hash) on a server. */
  frameUrl(port: number, path: string): string;
  /**
   * The URL "open in new tab" uses. It can differ from the frame URL: an isolated preview
   * opened directly in Safari cannot reach the IDE, so it goes through a page on our origin.
   */
  tabUrl(port: number, path: string): string;
  /** The server and path behind a frame URL the page reported, or undefined for a foreign URL. */
  locate(href: string): PreviewPlace | undefined;
  /** Whether `origin` (of a message from a frame) is one this transport serves `port` from. */
  ownsOrigin(origin: string, port: number): boolean;
  /** Calls back when frames must reload, for example after the bridge restarted. */
  onReloadNeeded(listener: () => void): () => void;
  dispose(): Promise<void>;
}

function unavailable(port: number): never {
  throw new Error(`No preview transport is available for port ${port}`);
}

/** The transport of a workspace without previews: it never reports a server. */
export function createInactivePreviewTransport(): PreviewTransport {
  return {
    kind: "none",
    whenReady: async () => {},
    register: () => {},
    unregister: () => {},
    servers: () => [],
    subscribe: () => () => {},
    frameUrl: unavailable,
    tabUrl: unavailable,
    locate: () => undefined,
    ownsOrigin: () => false,
    onReloadNeeded: () => () => {},
    dispose: async () => {},
  };
}
