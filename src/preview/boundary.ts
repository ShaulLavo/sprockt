// Which server a request reaching the preview service worker belongs to. The worker used to
// take that from the request's address alone, so a previewed page that asked for another
// workspace's mount, or another server's, was answered from there. Where the worker can tell
// which page asks, the page decides: it is served by the one server it was loaded from.
//
// This is defence in depth, not a boundary. Mounted previews are for trusted code only
// (mounted.ts). A service worker sees a page load only when the address it goes to is in its
// scope, and it never learns for certain who started one: a page can send its frame or a new
// tab to another mount with no referrer, or to any page of the IDE, and nothing here stops
// that. And the previewed code shares the IDE's origin, so it needs no request at all to read
// the IDE's storage. What these checks do is keep an honest project's mistakes (a redirect to
// the wrong port, a stray absolute link) from landing in another server or in the IDE.
import { parseMountedUrl, PREVIEW_PREFIX, type MountedLocation, type PreviewHome } from "./paths";

export type Route =
  /** The mounted place the address names, served by that workspace's server. */
  | { readonly to: "mount"; readonly place: MountedLocation }
  /** An address outside every mount, asked for by a previewed page: its own server's path. */
  | { readonly to: "own"; readonly home: MountedLocation }
  /** Not a preview's request: left to the network, like any page's. */
  | { readonly to: "network" }
  /** A previewed page asking for a mount that is not its own. */
  | { readonly to: "refuse" };

const samePair = (a: PreviewHome, b: PreviewHome): boolean =>
  a.workspace === b.workspace && a.port === b.port;

/**
 * Where a request for `requestUrl` (on our origin) goes. `source` is the mounted place of the
 * previewed page that asked, when one did; a request with no such page behind it (the pane
 * pointing its frame somewhere, a tab a person opened) goes where its address says.
 */
export function routeRequest(requestUrl: string, origin: string, source: MountedLocation | undefined): Route {
  const asked = parseMountedUrl(requestUrl, origin);
  if (!source) return asked ? { to: "mount", place: asked } : { to: "network" };
  if (asked) return samePair(asked, source) ? { to: "mount", place: asked } : { to: "refuse" };
  // Under the previews' prefix but no server's mount: nothing of the page's own server is there.
  const pathname = URL.parse(requestUrl)?.pathname ?? PREVIEW_PREFIX;
  const reserved = pathname === PREVIEW_PREFIX || pathname.startsWith(`${PREVIEW_PREFIX}/`);
  return reserved ? { to: "refuse" } : { to: "own", home: source };
}

/**
 * Whether a previewed page may open a WebSocket to `port`: only to the server it was loaded
 * from. The page names the port itself, so the worker checks it against where the page is.
 */
export function socketAllowed(pageUrl: string, origin: string, port: number): MountedLocation | undefined {
  const page = parseMountedUrl(pageUrl, origin);
  return page?.port === port ? page : undefined;
}
