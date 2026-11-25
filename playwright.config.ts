import { defineConfig, devices } from "@playwright/test";

// The suite runs against the production build on the persistent IndexedDB filesystem, the same
// path a visitor takes. SPROCKT_E2E_PORT picks the port when the default is taken.
const port = Number(process.env.SPROCKT_E2E_PORT ?? 4173);

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
  webServer: {
    command: `bun run preview --port ${port}`,
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
