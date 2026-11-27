# GitHub import and Share links

Importing public GitHub repositories via `/github/<owner>/<repo>` (and landing repo input) and sharing point-in-time workspace snapshots via `/s#share=<payload>`.

## Sub-features

- Landing page repo form (`repo-input`, `repo-submit`, inline `repo-error` validation) accepting `owner/repo`, `https://github.com/owner/repo`, or branch/tree URLs.
- Import progress screen (`import-page`, `import-stage`, `import-error`) proxied through Sprockt's Worker `/api/github/*` routes with rate-limit handling.
- Incomplete-import recovery: Sprockt never silently deletes a workspace; interrupted imports surface Retry and Delete controls (`incomplete-import`).
- Workspace Share action (`share-button`, `share-link`) creating a compressed fragment URL (`/s#share=...`) that restores into a new workspace in any browser.

## How to get to it (user POV)

Paste a GitHub repo into the Starters section input on `/` (or navigate directly to `/github/<owner>/<repo>`), or click **Share** in a workspace's title bar / phone menu to copy a `/s#share=...` link and open it in another browser window.

## Driving it with agent:browser

```bash
bun run agent:browser scenario github-import-and-share
```

The scenario validates inline repo error handling on `/`, creates a marker file inside a fresh starter workspace, triggers the real **Share** button to copy a `/s#share=...` URL, opens that URL in a clean isolated browser context, and asserts the marker file restores byte-for-byte.

## Gotchas

- Unauthenticated GitHub API requests share a 60 req/hr per-IP limit across lanes, so automated verification uses `/s#share=...` round-trips and mocked/local validation by default rather than hammering live GitHub endpoints on every run.
- `vite dev`, `vite preview`, and `scripts/serve-builds.ts` mount `/api/github/*` via `worker/github-proxy.ts`, matching the Cloudflare Worker (including `/api/github/release/...` for tagged `.tgz` assets). Static-only Mesh previews without the Cloudflare Worker do not serve `/api/github/*`.
