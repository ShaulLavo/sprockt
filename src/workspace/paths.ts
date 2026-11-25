/** Where a workspace's project lives inside the Waffle filesystem. */
export const PROJECT_ROOT = "/workspace";

/** Storage names of Sprockt workspaces share this prefix; other Waffle databases are ignored. */
const STORAGE_PREFIX = "sprockt-";

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function isWorkspaceId(value: string): boolean {
  return ID_PATTERN.test(value);
}

/** The IndexedDB workspace name Waffle opens for a workspace id. */
export function storageName(id: string): string {
  if (!isWorkspaceId(id)) throw new TypeError(`Invalid workspace id: ${id}`);
  return STORAGE_PREFIX + id;
}

/** The workspace id behind a stored Waffle workspace, or undefined when it is not one of ours. */
export function workspaceIdOf(storage: string): string | undefined {
  if (!storage.startsWith(STORAGE_PREFIX)) return undefined;
  const id = storage.slice(STORAGE_PREFIX.length);
  return isWorkspaceId(id) ? id : undefined;
}

/** A short random id, safe in a URL path and as a storage name. */
export function newWorkspaceId(random: () => number = Math.random): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 10 }, () => alphabet[Math.floor(random() * alphabet.length)]).join("");
}

/** A project path as the explorer shows it: relative to the project root. */
export function projectRelative(path: string): string | undefined {
  if (path === PROJECT_ROOT) return "";
  return path.startsWith(`${PROJECT_ROOT}/`) ? path.slice(PROJECT_ROOT.length + 1) : undefined;
}
