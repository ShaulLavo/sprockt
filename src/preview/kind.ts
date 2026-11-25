/** The build settings that decide which preview transport a build has. */
export interface PreviewBuild {
  /** True under `vite dev`. */
  readonly DEV: boolean;
  readonly VITE_SPROCKT_PREVIEWS?: string | undefined;
}

/**
 * Mounted previews share the IDE's origin, so a previewed project could reach the IDE's
 * storage. They exist only in development: under `vite dev`, or in a build made with
 * VITE_SPROCKT_PREVIEWS=mounted (the test build). Any other build, a public one above all, has
 * no preview transport until isolated preview origins are available.
 */
export function previewKind(build: PreviewBuild): "mounted" | "none" {
  return build.DEV || build.VITE_SPROCKT_PREVIEWS === "mounted" ? "mounted" : "none";
}

/** What the running build has. Only for code Vite bundles; the build plugin reads its config. */
export function buildPreviewKind(): "mounted" | "none" {
  return previewKind({
    DEV: import.meta.env.DEV,
    VITE_SPROCKT_PREVIEWS: import.meta.env.VITE_SPROCKT_PREVIEWS,
  });
}
