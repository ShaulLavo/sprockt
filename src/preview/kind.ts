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
 * - `mounted` previews share the IDE's origin, so a previewed project could reach the IDE's
 *   storage. They exist only in development: under `vite dev`, or in a build made with
 *   VITE_SPROCKT_PREVIEWS=mounted (the test build, and the owner's private preview).
 * - `isolated` previews give every server an origin of its own under the preview domain. A
 *   build that names the domain (VITE_SPROCKT_PREVIEW_DOMAIN) has them: that is the public build.
 * - Any other build has no preview transport.
 */
export function previewKind(build: PreviewBuild): PreviewKind {
  if (build.DEV || build.VITE_SPROCKT_PREVIEWS === "mounted") return "mounted";
  return previewDomain(build) === undefined ? "none" : "isolated";
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
