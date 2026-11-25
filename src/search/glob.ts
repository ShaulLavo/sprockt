// "Files to include" and "files to exclude": comma-separated globs over project-relative paths.
// `*` and `?` stay inside one path segment and `**` crosses segments. A glob without a slash
// matches any file or directory name (`*.css`, `dist`); one with a slash matches from the project
// root and covers everything under a matching directory (`src/lib`).

export type PathFilter = (path: string) => boolean;

function globSource(glob: string): string {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index] as string;
    if (char === "*" && glob[index + 1] === "*") {
      source += ".*";
      index += 1;
      if (glob[index + 1] === "/") index += 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return source;
}

function compileOne(glob: string): PathFilter {
  const trimmed = glob.replace(/^\.?\//, "").replace(/\/+$/, "");
  if (!trimmed.includes("/")) {
    const name = new RegExp(`^${globSource(trimmed)}$`);
    return (path) => path.split("/").some((segment) => name.test(segment));
  }
  const full = new RegExp(`^${globSource(trimmed)}(?:/.*)?$`);
  return (path) => full.test(path);
}

/** A filter for a comma-separated glob list, or null when the list is empty. */
export function compileGlobs(list: string): PathFilter | null {
  const filters = list
    .split(",")
    .map((glob) => glob.trim())
    .filter(Boolean)
    .map(compileOne);
  if (filters.length === 0) return null;
  return (path) => filters.some((filter) => filter(path));
}
