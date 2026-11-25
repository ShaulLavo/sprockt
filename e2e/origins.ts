// Where the suite's two servers listen (playwright.config.ts starts both). SPROCKT_E2E_PORT picks
// the first port when the default is taken; the second server takes the next one.

/** The production build with previews, which nearly every spec runs against. */
export const E2E_PORT = Number(process.env.SPROCKT_E2E_PORT ?? 4173);

/** One origin that serves two builds, picked by a cookie (scripts/serve-builds.ts). */
export const TWO_BUILDS_PORT = E2E_PORT + 1;
export const TWO_BUILDS_ORIGIN = `http://localhost:${TWO_BUILDS_PORT}`;
