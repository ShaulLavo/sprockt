// A previewed page lives under `/__preview/<workspace>/<port>/`, but its own links and forms
// say `/about`, `../notes` and `http://localhost:5173/login`, meaning places on its server.
// Followed as written, the browser would leave the mount: for the IDE's own pages, for another
// server's mount, or for the person's real localhost.
import { guestPlace, isUnderMount, mountedPath, parseMountedUrl } from "../paths";
import type { PageServer } from "./tunnel";

const pathOf = (url: URL) => `${url.pathname}${url.search}${url.hash}`;

/**
 * Where a link or a form of the page should really go: the same place on its server (or on the
 * server at the loopback port it names), under that server's mount. Undefined when the address
 * is right as it is: already in the mount, or another site.
 *
 * `raw` is the attribute as the page wrote it. A relative address is resolved against the
 * page's place on its server, not against its mounted address: `../../x` on the server's
 * `/a/b` is its `/x`, while in the browser it would climb into the mount's own directories.
 */
export function remounted(raw: string, page: URL, server: PageServer): string | undefined {
  const home = parseMountedUrl(`${page.origin}${server.mount}/`, page.origin);
  const resolved = URL.parse(raw, page);
  if (!home || !resolved) return undefined;
  const ours = resolved.origin === page.origin;
  if (ours && isUnderMount(resolved.pathname, home.workspace, home.port)) return undefined;
  // An absolute address on the page's own origin is the server's path, written with that origin.
  if (ours && URL.canParse(raw)) return mountedPath(home.workspace, home.port, pathOf(resolved));
  const here = parseMountedUrl(page.href, page.origin);
  const place = guestPlace(raw, here?.port === home.port ? here.path : "/", home.port);
  if (place === undefined || place === "elsewhere") return undefined;
  return mountedPath(home.workspace, place.port, place.path);
}

/**
 * Whether the browser may be let go to `address` from the page: anywhere on another site, and on
 * our own origin only inside the workspace's previews. Never the IDE's own pages.
 */
export function staysInPreview(address: string, page: URL, server: PageServer): boolean {
  const resolved = URL.parse(address, page);
  if (!resolved) return false;
  if (resolved.origin !== page.origin) return true;
  const home = parseMountedUrl(`${page.origin}${server.mount}/`, page.origin);
  const there = parseMountedUrl(resolved.href, page.origin);
  return home !== undefined && there?.workspace === home.workspace;
}

/**
 * The frame a link or form names, as it should be inside the preview's frame: one that would
 * replace the IDE around the preview (`_top`, `_parent`) is the preview's own frame instead.
 */
export function framedTarget(target: string | null, framed: boolean): string | null {
  const outer = target !== null && /^_(?:top|parent)$/i.test(target.trim());
  return framed && outer ? "_self" : target;
}
