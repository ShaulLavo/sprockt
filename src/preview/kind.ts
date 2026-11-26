/** The build settings that decide which preview transport a build has. */
export interface PreviewBuild {
  /** True under `vite dev`. */
  readonly DEV: boolean;
  readonly VITE_SPROCKT_PREVIEWS?: string | undefined;
  /** The domain every preview host ends with, for example `sprockt.dev` or `localhost:4174`. */
  readonly VITE_SPROCKT_PREVIEW_DOMAIN?: string | undefined;
}

export type PreviewKind = "mounted" | "isolated" | "none";

/** A host name with an optional port, and nothing else: no scheme, path or wildcard. */
const DOMAIN = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/;

/** The preview domain a build names, or undefined when it names none. A malformed one throws. */
export function previewDomain(build: PreviewBuild): string | undefined {
  const domain = build.VITE_SPROCKT_PREVIEW_DOMAIN?.trim().toLowerCase();
  if (!domain) return undefined;
  if (!DOMAIN.test(domain)) throw new Error(`VITE_SPROCKT_PREVIEW_DOMAIN is not a host name: ${domain}`);
  return domain;
}

/**
 * - `mounted` previews share the IDE's origin, so previewed code can reach the IDE's storage
 *   and every workspace's. They are for trusted code only: under `vite dev`, or in a build made
 *   with VITE_SPROCKT_PREVIEWS=mounted (the test build, and the owner's private preview).
 * - `isolated` previews give every server an origin of its own under the preview domain. A
 *   build that names the domain (VITE_SPROCKT_PREVIEW_DOMAIN) has them: that is the public build.
 * - Any other build has no preview transport.
 *
 * A build that names a preview domain and also asks for mounted previews is refused: naming
 * the domain says the build is meant for the public, and a public build must never be mounted.
 * A forgotten or left-over setting then fails the build instead of shipping the wrong one.
 */
export function previewKind(build: PreviewBuild): PreviewKind {
  if (build.DEV) return "mounted";
  const domain = previewDomain(build);
  const mounted = build.VITE_SPROCKT_PREVIEWS === "mounted";
  if (mounted && domain !== undefined)
    throw new Error(
      `VITE_SPROCKT_PREVIEWS=mounted and VITE_SPROCKT_PREVIEW_DOMAIN=${domain} cannot go together: a build with a preview domain is a public build, and mounted previews are for trusted code only`,
    );
  if (mounted) return "mounted";
  return domain === undefined ? "none" : "isolated";
}

function running(): PreviewBuild {
  return {
    DEV: import.meta.env.DEV,
    VITE_SPROCKT_PREVIEWS: import.meta.env.VITE_SPROCKT_PREVIEWS,
    VITE_SPROCKT_PREVIEW_DOMAIN: import.meta.env.VITE_SPROCKT_PREVIEW_DOMAIN,
  };
}

/** What the running build has. Only for code Vite bundles; the build plugin reads its config. */
export function buildPreviewKind(): PreviewKind {
  return previewKind(running());
}

/** The running build's preview domain; only an `isolated` build has one. */
export function buildPreviewDomain(): string | undefined {
  return previewDomain(running());
}
