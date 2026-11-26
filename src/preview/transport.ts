// The seam between the preview pane and whatever carries a dev server's responses to a frame.
// The pane only ever asks this interface for URLs and for what a frame's page reports.
//
// A transport belongs to one workspace, and every route it builds is keyed by that workspace
// and the port, never by the port alone, so that two workspaces with a server on the same
// port are routed apart.
//
// Only `isolated` keeps previewed code apart from the IDE, from other workspaces and from
// other servers: each server gets an origin of its own (`<id>-<port>-pv.<preview domain>`).
// It is what a public build has.
//
// `mounted` serves `/__preview/<workspace>/<port>/` on the IDE's own origin through a service
// worker. It isolates nothing: the previewed code shares the IDE's origin, can read its
// storage and every workspace's, and can send a frame anywhere on it. It is for trusted code
// only (development, the test build, the owner's private preview) and is never in a public
// build; a build that names a preview domain and asks for it is refused (kind.ts).
import type { PreviewServer as PreviewBackend } from "waffle/browser/preview";
import type { FrameMessage } from "./bridge";

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
  /**
   * Whether a page that reported itself takes the pane's commands (bridge.ts) by message.
   * Otherwise the pane steers the frame by its address alone.
   */
  readonly takesCommands: boolean;
  /**
   * What a dev server's shell needs in its environment so the server accepts requests under
   * this transport's host names (Vite refuses a Host it does not know).
   */
  readonly serverEnv: Readonly<Record<string, string>>;
  /** Resolves when frames can load. Rejects when previews cannot work in this browser. */
  whenReady(): Promise<void>;
  /** The runtime reports a listening port and the connection to it; `unregister` when it stops. */
  register(port: number, backend: PreviewBackend): void;
  unregister(port: number, backend: PreviewBackend): void;
  /** Servers that are listening right now and that a frame can load, lowest port first. */
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
  /**
   * Calls back with what the page in `frame` says about itself: only messages that really come
   * from that frame and from an origin this transport serves. Returns the function that stops it.
   */
  watch(frame: HTMLIFrameElement, listener: (message: FrameMessage) => void): () => void;
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
    takesCommands: false,
    serverEnv: {},
    whenReady: async () => {},
    register: () => {},
    unregister: () => {},
    servers: () => [],
    subscribe: () => () => {},
    frameUrl: unavailable,
    tabUrl: unavailable,
    locate: () => undefined,
    watch: () => () => {},
    onReloadNeeded: () => () => {},
    dispose: async () => {},
  };
}
