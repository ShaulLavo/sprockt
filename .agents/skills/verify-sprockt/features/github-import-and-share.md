# GitHub import and share links

Importing public GitHub repositories via `/github/<owner>/<repo>` (and the landing repo input) and sharing point-in-time workspace snapshots via `/s#share=<payload>`.

## Sub-features

- Landing page repo form (`repo-input`, `repo-submit`, inline `repo-error` validation) accepting `owner/repo`, `https://github.com/owner/repo`, or branch/tree URLs.
- Import progress screen (`import-page`, `import-stage`, `import-error`) proxied through Sprockt's Worker `/api/github/*` routes with rate-limit handling.
- First-open startup plan (`src/workspace/session/first-open.ts`): detected install and dev commands run once when the imported workspace first opens in `WorkspaceSession`. Because `pendingImport` is cleared and flushed on consumption, reloading the workspace tab later requires a manual start, while reloading only the preview frame keeps the server running.
- Incomplete-import recovery: Sprockt never silently deletes a workspace. Interrupted imports show Retry and Delete controls (`incomplete-import`).
- Workspace Share action (`share-button`, `share-link`) creating a compressed fragment URL (`/s#share=...`) that restores into a new workspace in any browser.

## How to get to it (user POV)

Paste a GitHub repo into the Starters section input on `/` (or navigate directly to `/github/<owner>/<repo>`). After the archive downloads and extracts into a new workspace, the detected install and dev plan starts on first open. Or click **Share** in a workspace's title bar or phone menu to copy a `/s#share=...` link and open it in another browser window.

## Driving it with agent:browser

```bash
bun run agent:browser scenario github-import-and-share
bun run agent:browser scenario github-real-repo
bun run agent:browser scenario github-real-repo --url https://sprockt.dev/ --live
```

- `github-import-and-share` validates inline repo error handling on `/`, creates a marker file inside a fresh starter workspace, triggers the real **Share** button to copy a `/s#share=...` URL, opens that URL in a clean isolated browser context, and asserts the marker file restores byte-for-byte.
- `github-real-repo` (paired with a Playwright E2E spec) runs two immutable public GitHub imports from their real archives. The first runs `bun install` to prove workspace linkage, catalog versions, and an override. The second imports a separate Vite project, runs `bun install`, and verifies the served preview renders. Its `cold-boot.json` records timings relative to activation and browser navigation for each import. It also supports exact production verification via `--url https://sprockt.dev/ --live`.

## Gotchas

- Unauthenticated GitHub API requests share a 60 req/hr per-IP limit across lanes, so run `github-real-repo` deliberately rather than hammering live GitHub endpoints in tight loops. `github-import-and-share` covers form validation and `/s#share=...` round-trips without hitting GitHub.
- `vite dev`, `vite preview`, and `scripts/serve-builds.ts` mount `/api/github/*` via `worker/github-proxy.ts`, matching the Cloudflare Worker (including `/api/github/release/...` for tagged `.tgz` assets). Static-only Mesh previews without the Cloudflare Worker do not serve `/api/github/*`.
