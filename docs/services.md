# Import, share and export services

These modules have no UI code. Each takes plain data or a `ProjectFs` (`src/lib/fs/types.ts`), so
none depends on React or on Waffle directly.

| Module                | Entry points                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| `src/lib/fs`          | `ProjectFs`, `FileEntry`, `MemoryFs`, `collectFiles`, `writeFiles`                                 |
| `src/lib/zip`         | `createZip`, `createZipBlob`, `zipWorkspace`, `crc32`                                              |
| `src/importer/github` | `parseGitHubSource`, `importGitHubRepo`, `fetchRepoInfo`, `readTar`                                |
| `src/importer/detect` | `detectProject`, `detectProjectInFs`                                                               |
| `src/share`           | `encodeShareFragment`, `decodeShareFragment`, `diffSnapshot`, `applySnapshot`, `forkFromGitHubUrl` |

## `ProjectFs` and Waffle

`ProjectFs` uses Waffle's names (`readFile`, `writeFile`, `readdir`, `stat`,
`kind: "file" | "directory" | "symlink"`) with async, path-based calls. An adapter over Waffle's
filesystem only needs to map paths and turn `mkdirp` into `mkdir`.

## GitHub import

Browsers can't fetch `codeload.github.com` because it sends no CORS headers. Imports go through
the Worker routes in `worker/github-proxy.ts`, which `worker/index.ts` serves under `/api/github/`:

- `GET /api/github/repo/<owner>/<repo>` returns `{ owner, repo, defaultBranch, sizeKiB }`.
- `GET /api/github/refs/<owner>/<repo>/<segment>` returns `{ branches, tags }` whose names start
  with `<segment>`.
- `GET /api/github/archive/<owner>/<repo>/<ref>` streams the `tar.gz`.

`wrangler.jsonc` runs the Worker first only for `/api/*`; every other path is served by the static
assets without running code. The Worker sets no cookies.

Worker bindings and variables:

- `GITHUB_API_LIMITER` (in `wrangler.jsonc`): 30 requests a minute per client address on the
  routes that spend API quota (`repo`, `refs`). Archives are not limited.
- `GITHUB_TOKEN` (optional secret): a token with no scopes. It raises the API limit from 60 to
  5000 requests an hour. It is sent only to `api.github.com`, never to codeload, and the proxy
  refuses private repositories either way.
- `GITHUB_PROXY_MAX_ARCHIVE_BYTES`: largest archive passed through (default 100 MiB).

Archives of a full commit id are cached for a year. Branch archives and unauthenticated metadata
are cached for 5 minutes. Misses are cached for a minute, and server errors aren't cached.
Requests that carry the token stay out of the shared subrequest cache. Every redirect hop must
stay on the route's own origin and path shape. Ref lists over 1 MiB are refused.

`/tree/<ref>/<path>` links are ambiguous when a branch name has slashes. The importer asks the
`refs` route for branches and tags starting with the first segment, then downloads the longest
one that exists, as `refs/heads/...` or `refs/tags/...`. A branch beats a tag with the same name.
`/tree/refs/heads/...` and `/tree/refs/tags/...` links look only in that namespace. Single-segment
refs and full commit ids skip the lookup. A hex first segment that matches no ref is taken as an
abbreviated commit id.

## Share links

`#share=<base64url(deflate-raw(JSON))>` holds a template id, the files changed or added since the
template, and the files deleted. Links are capped at 16 KiB by default. Bigger snapshots get
`{ ok: false, reason: "too-big" }`, and the UI should offer a ZIP or a GitHub fork instead.
Decoding caps the decompressed size at 8 MiB.
