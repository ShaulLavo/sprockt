# Sprockt: notes for agents

Read `ARCHITECTURE.md` first: module map, seams, deploy, testing and known gaps.

## Hard invariant: previews and cookies

Public previews are served on `<id>-<port>-pv.sprockt.dev`, under the same registrable domain
as the IDE. The owner accepted that for V1 (2026-11-26) because nothing on `sprockt.dev` reads
a cookie.

**If Sprockt ever adds user accounts, logins, GitHub OAuth or session cookies on `sprockt.dev`,
previews MUST first move to a dedicated preview-only registrable domain, and that domain must
be submitted to the Public Suffix List.**

Why: preview code can set `Domain=sprockt.dev` cookies that reach the IDE and every other
preview.

Until then, nothing of ours on `sprockt.dev` may set or trust a cookie. The preview domain is
one setting per place (`VITE_SPROCKT_PREVIEW_DOMAIN` for the IDE build, `PREVIEW_DOMAIN` and
the route in `wrangler.preview.jsonc`); details in `ARCHITECTURE.md`, "Deploy".

## Previews

- Only `isolated` previews separate previewed code from the IDE and from other workspaces.
- `mounted` previews are for trusted code only (development, tests, the owner's private
  preview) and isolate nothing. A build that names a preview domain cannot be mounted.
