// Pure helpers for project-relative paths ("src/main.ts"; the project root is ""). No DOM, no Solid.

const MAX_NAME_BYTES = 255;
const encoder = new TextEncoder();

export function joinPath(directory: string, name: string): string {
  return directory === "" ? name : `${directory}/${name}`;
}

/** The directory holding `path`; "" for a top-level entry. */
export function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Whether `path` lies below `ancestor` ("" is the ancestor of everything). */
export function isInside(path: string, ancestor: string): boolean {
  return ancestor === "" ? path !== "" : path.startsWith(`${ancestor}/`);
}

export function isSameOrInside(path: string, ancestor: string): boolean {
  return path === ancestor || isInside(path, ancestor);
}

/** The path `path` gets after the entry at `from` moved to `to`. Other paths are unchanged. */
export function rebase(path: string, from: string, to: string): string {
  if (path === from) return to;
  return isInside(path, from) ? to + path.slice(from.length) : path;
}

/** Every directory above `path`, outermost first: "a/b/c" gives ["a", "a/b"]. */
export function ancestorsOf(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

export type NameProblem = "empty" | "separator" | "reserved" | "too-long" | "exists";

/**
 * Why `name` cannot be used for a new entry or a rename, or undefined when it can. `siblings`
 * are the names already in the directory, without the entry being renamed.
 */
export function checkName(name: string, siblings: Iterable<string>): NameProblem | undefined {
  if (name === "") return "empty";
  if (name === "." || name === "..") return "reserved";
  if (/[/\\\0]/.test(name)) return "separator";
  if (encoder.encode(name).byteLength > MAX_NAME_BYTES) return "too-long";
  for (const sibling of siblings) if (sibling === name) return "exists";
  return undefined;
}

/**
 * A relative path from outside (an upload) checked: the path itself when it is plain, undefined
 * when it is absolute, empty, has an empty, "." or ".." segment, or contains a backslash or NUL.
 * Nothing is repaired: an absolute name is not a relative one with its slash stripped.
 */
export function safeRelativePath(path: string): string | undefined {
  if (path === "" || /[\\\0]/.test(path)) return undefined;
  const plain = path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
  return plain ? path : undefined;
}
