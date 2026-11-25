// URL layout of mounted previews. A dev server on port 5173 of workspace `abc` is served at
// `<origin>/__preview/abc/5173/<path>` by the service worker registered for `/__preview/`. The
// workspace is part of the route so that two workspaces with a server on the same port never
// answer each other's requests.
import { isWorkspaceId } from "../workspace/paths";

export const PREVIEW_PREFIX = "/__preview";
export const SERVICE_WORKER_PATH = "/preview-sw.js";
/** The script the service worker adds to every previewed HTML page. */
export const CLIENT_SCRIPT_PATH = "/preview-client.js";

export interface MountedLocation {
  readonly workspace: string;
  readonly port: number;
  /** Path, query and hash as the dev server sees them; always starts with "/". */
  readonly path: string;
}

/** A stand-in for the dev server's own origin, to resolve its paths the way a browser would. */
const GUEST_ORIGIN = "http://guest.invalid";

const pathOf = (url: URL) => `${url.pathname}${url.search}${url.hash}`;

/**
 * Normalizes what a person types in the URL bar into a path the dev server understands. The
 * path is resolved against the server's own root first, the way a browser resolves it, so `..`
 * segments (written out, percent-encoded or with backslashes) stop at that root. Prefixing the
 * mount before the browser resolved them would let them climb out of it, into another port's
 * mount or another workspace's.
 */
export function normalizePreviewPath(input: string): string {
  // Leading slashes are dropped so that `//host/path` stays a path and does not name a host.
  const rooted = `/${input.trim().replace(/^[/\\]+/, "")}`;
  const url = URL.parse(rooted, GUEST_ORIGIN);
  return url?.origin === GUEST_ORIGIN ? pathOf(url) : "/";
}

/**
 * Where a redirect leads on the dev server that sent it, given the path that was asked for:
 * a path on that server, resolved and kept under its root. Undefined for a redirect to another
 * site, which is left as the server wrote it.
 */
export function redirectedPath(location: string, from: string): string | undefined {
  const base = URL.parse(normalizePreviewPath(from), GUEST_ORIGIN);
  const url = base && URL.parse(location, base);
  return url?.origin === GUEST_ORIGIN ? pathOf(url) : undefined;
}

/** The directory all previews of one workspace live under, without a trailing slash. */
export function workspaceMount(workspace: string): string {
  return `${PREVIEW_PREFIX}/${workspace}`;
}

/** The directory one server is mounted at, without a trailing slash. */
export function serverMount(workspace: string, port: number): string {
  return `${workspaceMount(workspace)}/${port}`;
}

/** Whether a URL path, once a browser has resolved it, is inside one server's mount. */
export function isUnderMount(pathname: string, workspace: string, port: number): boolean {
  const resolved = URL.parse(pathname, GUEST_ORIGIN)?.pathname;
  return resolved !== undefined && resolved.startsWith(`${serverMount(workspace, port)}/`);
}

/**
 * The mounted path of `path` on `port`, without the origin. It always stays inside that
 * server's mount: a path that would not is answered with the server's root.
 */
export function mountedPath(workspace: string, port: number, path: string): string {
  const mount = serverMount(workspace, port);
  const mounted = mount + normalizePreviewPath(path);
  return isUnderMount(mounted, workspace, port) ? mounted : `${mount}/`;
}

/**
 * The `Location` to send instead of the one a server on `port` sent in answer to a request for
 * `from`: the same place on that server, under its mount. Undefined when the header is right as
 * it is: it already names a path in the mount, or it leads to another site.
 */
export function mountedRedirect(
  workspace: string,
  port: number,
  location: string,
  from: string,
): string | undefined {
  if (location.startsWith("/") && isUnderMount(location, workspace, port)) return undefined;
  const path = redirectedPath(location, from);
  return path === undefined ? undefined : mountedPath(workspace, port, path);
}

/** The workspace a path under `/__preview/` belongs to, or undefined for any other path. */
export function workspaceOfPath(pathname: string): string | undefined {
  const workspace = /^\/__preview\/([^/]+)(?:\/|$)/.exec(pathname)?.[1];
  return workspace !== undefined && isWorkspaceId(workspace) ? workspace : undefined;
}

/** Reads the workspace, the port and the server-side path back out of a mounted preview URL. */
export function parseMountedUrl(href: string, origin: string): MountedLocation | undefined {
  const url = URL.parse(href);
  if (!url || url.origin !== origin) return undefined;
  const match = /^\/__preview\/([^/]+)\/(\d{1,5})(\/.*)?$/.exec(url.pathname);
  const workspace = match?.[1];
  if (!match || workspace === undefined || !isWorkspaceId(workspace)) return undefined;
  return { workspace, port: Number(match[2]), path: `${match[3] ?? "/"}${url.search}${url.hash}` };
}
