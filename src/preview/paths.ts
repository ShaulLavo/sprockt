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

/** Normalizes what a person types in the URL bar into a path the dev server understands. */
export function normalizePreviewPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "/";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/** The directory all previews of one workspace live under, without a trailing slash. */
export function workspaceMount(workspace: string): string {
  return `${PREVIEW_PREFIX}/${workspace}`;
}

/** The directory one server is mounted at, without a trailing slash. */
export function serverMount(workspace: string, port: number): string {
  return `${workspaceMount(workspace)}/${port}`;
}

/** The mounted path of `path` on `port`, without the origin. */
export function mountedPath(workspace: string, port: number, path: string): string {
  return serverMount(workspace, port) + normalizePreviewPath(path);
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
