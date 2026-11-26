import type { TunnelTarget } from "./websocket";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Which server a previewed page belongs to, read from the client script's tag. */
export interface PageServer {
  readonly port: number;
  /** Where the server is mounted on the page's origin, such as `/__preview/abc/5173`. */
  readonly mount: string;
}

/**
 * Decides whether a WebSocket URL a previewed page asked for means "my own dev server". It does
 * when it points at the page's host (the dev server's client code builds its URL from
 * `location`) or at the server's port on loopback. Anything else is a real socket elsewhere.
 */
export function tunnelTarget(input: string | URL, page: URL, server: PageServer): TunnelTarget | undefined {
  const url = new URL(String(input), page);
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") return undefined;
  const ownHost = url.host === page.host;
  const ownLoopback = LOOPBACK.has(url.hostname) && Number(url.port || 80) === server.port;
  if (!ownHost && !ownLoopback) return undefined;
  const mounted = url.pathname === server.mount || url.pathname.startsWith(`${server.mount}/`);
  const path = mounted ? url.pathname.slice(server.mount.length) || "/" : url.pathname;
  return { port: server.port, target: path + url.search, url: url.href };
}
