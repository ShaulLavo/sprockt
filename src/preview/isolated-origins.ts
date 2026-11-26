// The addresses of isolated previews: every server of a workspace has an origin of its own,
// `<scheme>://<id>-<port>-pv.<domain>`, where `<id>` is derived from the IDE's origin and the
// workspace's preview identity (identity.ts). No DOM here: only names and what they mean.
import {
  isPreviewOrigin,
  parsePreviewHost,
  previewOrigin,
  type FrameMessage as OriginMessage,
  type PreviewOriginConfig,
} from "bun-wasm/preview-origins";
import { frameMessage, type FrameMessage } from "./bridge";
import { FRAME_PAGE_PATH, normalizePreviewPath } from "./paths";
import type { PreviewPlace } from "./transport";

export interface PreviewOrigins {
  /** The origin a server's pages live on. */
  origin(port: number): string;
  /** The address of `path` (with query and hash) on a server. */
  url(port: number, path: string): string;
  /** The server and path behind an address, or undefined when it is not one of this workspace's. */
  locate(href: string): PreviewPlace | undefined;
}

/** The address of the IDE-origin page that shows the preview address `url` in its own tab. */
export function framePage(ideOrigin: string, url: string): string {
  const page = new URL(FRAME_PAGE_PATH, ideOrigin);
  page.searchParams.set("url", url);
  return page.href;
}

/** `id`: the workspace's label in its host names (`previewOriginId`). */
export function previewOrigins(config: PreviewOriginConfig, id: string): PreviewOrigins {
  const origin = (port: number): string => previewOrigin(config, id, port);
  return {
    origin,
    // The path is resolved against the server's root first, so it can never name another host.
    url: (port, path) => origin(port) + normalizePreviewPath(path),
    locate(href) {
      const url = URL.parse(href);
      if (!url || !isPreviewOrigin(url.origin, config)) return undefined;
      const host = parsePreviewHost(url.host, config);
      if (host?.id !== id) return undefined;
      return { port: host.port, path: `${url.pathname}${url.search}${url.hash}` };
    },
  };
}

/**
 * What a page on a preview origin told its embedder, in the pane's own terms. Its script
 * (bun-wasm's, injected by the origin's service worker) reports where the page is: when a
 * document commits, when it finished loading, and after every history change. A report that
 * the server did not answer says nothing about a place and is not passed on.
 */
export function placeReport(message: OriginMessage): FrameMessage | undefined {
  if (message.event === "error") return undefined;
  return frameMessage({ type: "location", href: message.href, title: message.title ?? "" });
}

/**
 * How often a frame is sent to its address again after the origin's service worker said the
 * server is not reachable yet, and how long to wait before each try. The tab that runs the
 * server may still be handing the worker its connection; a server that is really down stays
 * on the worker's own error page after the last try.
 */
export const RETRY_DELAYS_MS: readonly number[] = [500, 1000, 1500, 2000];

export interface Retries {
  /**
   * The worker answered in the server's place for the frame at `address`. Returns how long to
   * wait before sending the frame there again, or undefined when it is left on that answer:
   * the failure is not one a retry helps, or this address has had its tries.
   */
  unanswered(address: string, transient: boolean): number | undefined;
  /** A page of the server reported itself: whatever fails next starts over. */
  answered(): void;
}

/** Counts tries per address: a frame that was sent somewhere else starts over. */
export function createRetries(delays: readonly number[] = RETRY_DELAYS_MS): Retries {
  let failing: string | undefined;
  let tries = 0;
  return {
    unanswered(address, transient) {
      if (address !== failing) tries = 0;
      failing = address;
      const delay = transient ? delays[tries] : undefined;
      if (delay !== undefined) tries += 1;
      return delay;
    },
    answered() {
      failing = undefined;
    },
  };
}
