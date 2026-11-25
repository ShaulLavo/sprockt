import type { BrowserContext, Page } from "@playwright/test";
import { expect, newWorkspace, runInTerminal, test, writeFile } from "./helpers";
import { TWO_BUILDS_ORIGIN } from "./origins";
import { BUILD_COOKIE, type Deploy } from "../scripts/serve-builds";

// These tests run on the origin that serves two builds (scripts/serve-builds.ts): the test build
// with previews, and a build without them once the browser context has the cookie. That is an
// origin whose deploy changed under tabs that are still open.
test.use({ baseURL: TWO_BUILDS_ORIGIN });

/** From here on, this browser context gets a deploy without previews. */
const deployWithoutPreviews = (context: BrowserContext, deploy: Exclude<Deploy, "on"> = "off") =>
  context.addCookies([{ name: BUILD_COOKIE, value: deploy, url: TWO_BUILDS_ORIGIN }]);

const SERVER = `
Bun.serve({
  port: 3000,
  fetch: () =>
    new Response("<!doctype html><html><head><title>Guest</title></head><body><h1>Guest page</h1></body></html>", {
      headers: { "content-type": "text/html; charset=utf-8" },
    }),
});
`;

/** How many service workers this origin has registered. */
const registrations = (page: Page) =>
  page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length);

/**
 * A workspace of the build with previews serves a guest page; then the deploy changes while that
 * tab stays open. Afterwards the old build's worker must be gone and the guest's address must
 * not reach the old tab's server.
 */
async function deployChangesUnderAnOpenTab(
  page: Page,
  context: BrowserContext,
  deploy: Exclude<Deploy, "on">,
): Promise<void> {
  // The build with previews: a workspace runs a server, and its address works in a tab.
  const id = await newWorkspace(page);
  await writeFile(page, "server.ts", SERVER);
  await runInTerminal(page, "bun server.ts");
  await expect(page.frameLocator("[data-testid=preview-frame]").getByRole("heading")).toHaveText(
    "Guest page",
  );
  const address = `/__preview/${id}/3000/`;
  const before = await context.newPage();
  await before.goto(address);
  await expect(before.getByRole("heading")).toHaveText("Guest page");
  await before.close();
  expect(await registrations(page)).toBe(1);

  // The deploy changes. The tab that hosts the server stays open on the old build.
  await deployWithoutPreviews(context, deploy);
  const landing = await context.newPage();
  await landing.goto("/");
  await expect(landing.getByTestId("new-workspace")).toBeVisible();
  // Loading any page of the new build removes the old build's worker.
  await expect.poll(() => registrations(landing)).toBe(0);

  // The old tab is still there and still has its server, and the address no longer reaches it.
  await expect(page.getByTestId("workbench")).toHaveAttribute("data-stage", "ready");
  const after = await context.newPage();
  await after.goto(address);
  await expect(after.locator("#app")).toBeAttached();
  await expect(after.getByText("Guest page")).toHaveCount(0);
  expect(await after.evaluate(() => navigator.serviceWorker.controller)).toBeNull();
}

test.describe("with a tab of the earlier build still open", () => {
  test.beforeEach(({ browserName }) => {
    // The earlier build has to run a server, and Bun's browser engine traps in Playwright's
    // WebKit (ARCHITECTURE.md "Known gaps").
    test.fixme(browserName === "webkit", "Bun's browser engine traps in WebKit");
  });

  test("a page of a build without previews removes the earlier build's worker", async ({ page, context }) => {
    // The worker file is still the old one here, so the browser finds nothing to update to: only
    // the new build's page can take the worker down.
    await deployChangesUnderAnOpenTab(page, context, "off-old-worker");
  });

  test("a deploy without previews leaves no preview worker and no route to the old tab", async ({
    page,
    context,
  }) => {
    await deployChangesUnderAnOpenTab(page, context, "off");
  });
});

test("a build without previews publishes a worker that serves nothing and removes itself", async ({
  page,
  context,
}) => {
  await deployWithoutPreviews(context);
  await page.goto("/");
  await expect(page.getByTestId("new-workspace")).toBeVisible();

  // Where the routing worker was, there is one without any routing in it, and no client script.
  const worker = await page.request.get("/preview-sw.js");
  expect(worker.status()).toBe(200);
  const source = await worker.text();
  expect(source).toContain("unregister");
  expect(source).not.toContain("preview-socket");
  expect(source).not.toContain("fetch");
  expect((await page.request.get("/preview-client.js")).status()).toBe(404);

  // A browser that holds the earlier build's registration updates to this worker. Registering it
  // by hand does the same: it takes over and its registration is gone.
  await page.evaluate(() => navigator.serviceWorker.register("/preview-sw.js", { scope: "/__preview/" }));
  await expect.poll(() => registrations(page)).toBe(0);
});
