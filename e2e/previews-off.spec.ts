import type { BrowserContext, Page } from "@playwright/test";
import { expect, newWorkspace, runInTerminal, test, writeFile } from "./helpers";
import { TWO_BUILDS_ORIGIN } from "./origins";
import { expectPreviewText, PROBE } from "./preview-probe";
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

/** The same page with the probe that lets a test read it on an origin of its own (preview-probe.ts). */
const PROBED_SERVER = `
Bun.serve({
  port: 3000,
  fetch: (request) =>
    new URL(request.url).pathname === "/probe.js"
      ? new Response(Bun.file("probe.js"), { headers: { "content-type": "text/javascript" } })
      : new Response("<!doctype html><title>Guest</title><script src='/probe.js'></script><h1>Guest page</h1>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
});
`;

/**
 * The guest page with a WebSocket that stays open: it says hello when it opens, and the page
 * keeps what the server echoes and whether the socket is still open.
 */
const SOCKET_SERVER = `
const PAGE = "<!doctype html><html><head><title>Guest</title></head><body><h1>Guest page</h1><script>" +
  "window.echoes = []; window.socketState = 'connecting';" +
  "window.socket = new WebSocket('ws://' + location.host + '/ws');" +
  "socket.onopen = () => { window.socketState = 'open'; socket.send('hello'); };" +
  "socket.onmessage = (event) => window.echoes.push(event.data);" +
  "socket.onclose = () => { window.socketState = 'closed'; };" +
  "</script></body></html>";
Bun.serve({
  port: 3000,
  fetch(request, server) {
    if (new URL(request.url).pathname === "/ws") return server.upgrade(request) ? undefined : new Response("no upgrade", { status: 400 });
    return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
  websocket: {
    message(socket, message) {
      socket.send(String(message).toUpperCase());
    },
  },
});
`;

/** What the guest page above keeps about its socket. */
interface SocketPage {
  echoes: string[];
  socketState: string;
  socket: WebSocket;
}

/** How many service workers this origin has registered. */
const registrations = (page: Page) =>
  page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length);

/**
 * The build with previews: a workspace in `page` runs a server, and its address works in a tab
 * of its own. Returns that address. `page` stays open and keeps hosting the server.
 */
async function hostAGuest(page: Page, context: BrowserContext, server = SERVER): Promise<string> {
  const id = await newWorkspace(page);
  await writeFile(page, "server.ts", server);
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
  return address;
}

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
  const address = await hostAGuest(page, context);

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

  test("a deploy that moves to isolated previews takes the mounted worker down, and previews on its own origins", async ({
    page,
    context,
  }) => {
    await deployChangesUnderAnOpenTab(page, context, "isolated");

    // The new build's previews are not on this origin at all: a server gets a host of its own.
    const fresh = await context.newPage();
    await newWorkspace(fresh);
    await writeFile(fresh, "probe.js", PROBE);
    await writeFile(fresh, "server.ts", PROBED_SERVER);
    await runInTerminal(fresh, "bun server.ts");
    await expectPreviewText(fresh, "h1", "Guest page");
    const address = new URL((await fresh.getByTestId("preview-frame").getAttribute("src")) ?? "");
    expect(address.host).toMatch(/^[a-z2-7]{52}-3000-pv\.localhost:\d+$/);
    expect(await registrations(fresh)).toBe(0);
  });

  test("a preview that is still open gets nothing more from the workspace once the deploy changed", async ({
    page,
    context,
  }) => {
    const address = await hostAGuest(page, context);
    const open = await context.newPage();
    await open.goto(address);
    await expect(open.getByRole("heading")).toHaveText("Guest page");
    /** What the open page's own script gets from its server now. */
    const again = () => open.evaluate(async () => (await fetch("./data")).text());
    expect(await again()).toContain("Guest page");

    // The deploy changes. No page is loaded, and the worker file is still the old one. The
    // worker asks the deploy for every request, so the very next one is not answered from the
    // workspace: it used to trust its last answer for half a minute.
    await deployWithoutPreviews(context, "off-old-worker");
    expect(await again()).not.toContain("Guest page");
    await expect.poll(() => registrations(open)).toBe(0);
    await expect(page.getByTestId("workbench")).toHaveAttribute("data-stage", "ready");
  });

  test("a WebSocket that was open when the deploy changed is closed, and carries nothing more", async ({
    page,
    context,
  }) => {
    const address = await hostAGuest(page, context, SOCKET_SERVER);
    const open = await context.newPage();
    await open.goto(address);
    const socket = () =>
      open.evaluate(() => {
        const guest = window as unknown as SocketPage;
        return { state: guest.socketState, echoes: guest.echoes };
      });
    await expect.poll(socket).toEqual({ state: "open", echoes: ["HELLO"] });

    // The deploy changes. No page is loaded, the worker file is still the old one, and the
    // socket was handed to the tab that runs the server long ago: the worker is out of it.
    await deployWithoutPreviews(context, "off-old-worker");
    await open.evaluate(() => (window as unknown as SocketPage).socket.send("after the deploy changed"));
    // The tab that runs the server asks the deploy before it passes the frame on. It does not
    // pass it on: the server never sees it, nothing is echoed, and the socket ends.
    await expect.poll(socket).toEqual({ state: "closed", echoes: ["HELLO"] });
    await expect(page.getByTestId("workbench")).toHaveAttribute("data-stage", "ready");
  });

  test("a preview address opened right after the deploy changed is not served by the old worker", async ({
    page,
    context,
  }) => {
    const address = await hostAGuest(page, context);
    // The deploy changes, and nobody opens a page of the new build: no page retires the worker,
    // and the worker file is still the old one, so the browser has nothing to update it to.
    await deployWithoutPreviews(context, "off-old-worker");
    expect(await registrations(page)).toBe(1);

    // The old worker is asked directly. It asks the deploy before it answers, and does not.
    const after = await context.newPage();
    await after.goto(address);
    await expect(after.locator("#app")).toBeAttached();
    await expect(after.getByText("Guest page")).toHaveCount(0);
    // Having learned that, it retired itself: the registration is gone for every page.
    await expect.poll(() => registrations(after)).toBe(0);
    await expect(page.getByTestId("workbench")).toHaveAttribute("data-stage", "ready");
    await after.reload();
    await expect(after.getByText("Guest page")).toHaveCount(0);
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
