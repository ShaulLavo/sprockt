// A previewed page lives under `/__preview/<workspace>/<port>/`, but its own links and forms
// say `/about` and `/notes`, meaning the server's root. Followed as written, the browser would
// leave the mount and load the IDE's own page.

/**
 * Where a link or a form of the page should really go: the same place on the server, under its
 * mount. Undefined when the address is right as it is: another site, or already in the mount.
 */
export function remounted(href: string, page: URL, mount: string): string | undefined {
  const url = URL.parse(href, page);
  if (!url || url.origin !== page.origin) return undefined;
  if (url.pathname === mount || url.pathname.startsWith(`${mount}/`)) return undefined;
  return mount + url.pathname + url.search + url.hash;
}
