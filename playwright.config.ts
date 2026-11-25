import { defineConfig, devices } from "@playwright/test";
import { E2E_PORT as port, TWO_BUILDS_ORIGIN, TWO_BUILDS_PORT } from "./e2e/origins";

// The suite runs against the production build on the persistent IndexedDB filesystem, the same
// path a visitor takes. SPROCKT_E2E_PORT picks the port when the default is taken.

export default defineConfig({
  testDir: "e2e",
  // A hang cap, not a speed target: a cold start downloads and compiles an 18 MB guest set.
  timeout: 240_000,
  expect: { timeout: 120_000 },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: `bun run preview --port ${port}`,
      url: `http://localhost:${port}`,
      reuseExistingServer: false,
    },
    // For e2e/previews-off.spec.ts: the app built a second time, without previews, and one
    // origin that serves either build (scripts/serve-builds.ts). The spec moves a browser from
    // the build with previews to the one without, as a new deploy would.
    {
      command: `env VITE_SPROCKT_PREVIEWS= bunx vite build --outDir dist-previews-off --logLevel warn && bun scripts/serve-builds.ts --port ${TWO_BUILDS_PORT}`,
      url: TWO_BUILDS_ORIGIN,
      reuseExistingServer: false,
      // A hang cap for the second build, not a speed target.
      timeout: 300_000,
    },
  ],
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
