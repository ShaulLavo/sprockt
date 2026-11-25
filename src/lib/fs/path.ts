/**
 * Normalizes a workspace-relative path: drops leading `/` and `./`, empty and
 * `.` segments, and trailing slashes. Returns `undefined` for a path that
 * escapes the root (`..`) or contains a NUL or backslash, so archive entries
 * can never write outside the workspace.
 */
export function normalizePath(path: string): string | undefined {
  if (path.includes("\0") || path.includes("\\")) return undefined;
  const segments = path.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..")) return undefined;
  return segments.join("/");
}

export function joinPath(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

/** The parent directory of `path`, `""` for a top-level entry. */
export function parentPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/** The first path segment, or the whole path when it has no slash. */
export function firstSegment(path: string): string {
  const slash = path.indexOf("/");
  return slash === -1 ? path : path.slice(0, slash);
}
