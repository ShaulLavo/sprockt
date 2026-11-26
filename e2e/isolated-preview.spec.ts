import type { Page } from "@playwright/test";
import { expect, newWorkspace, runInTerminal, test, writeFile } from "./helpers";
import { TWO_BUILDS_ORIGIN, TWO_BUILDS_PORT } from "./origins";
import { clickInPreview, expectPreviewText, inPreview, PROBE } from "./preview-probe";
import { BUILD_COOKIE } from "../scripts/serve-builds";
import { TAB_POLICY } from "../src/runtime/tab-policy";

// The build with isolated previews, as a public deploy has them: every server of a workspace
// gets an origin of its own. Here the preview hosts are names under `localhost` on the server's
// own port (scripts/serve-builds.ts), answered by the Worker that serves the real hosts. The
// previewed pages are read through the probe their server adds (preview-probe.ts).
test.use({ baseURL: TWO_BUILDS_ORIGIN });

test.beforeEach(async ({ context }) => {
  await context.addCookies([{ name: BUILD_COOKIE, value: "isolated", url: TWO_BUILDS_ORIGIN }]);
});

/** What the page's script does with the root of its own origin, and what it can see of the IDE. */
const APP = `
const show = (id, text) => {
  const element = document.getElementById(id);
  if (element) element.textContent = text;
};
show("where", location.origin);
fetch("/api/who").then((response) => response.json()).then((who) => show("api", "host " + who.host + " cookie " + who.cookie));
let ide = "blocked";
try { ide = "readable: " + parent.localStorage.length; } catch {}
show("ide", ide);
const push = document.getElementById("push");
if (push) push.onclick = () => history.pushState(null, "", "/pushed?x=1");
const socket = new WebSocket("ws://" + location.host + "/ws");
socket.onopen = () => socket.send("ping");
socket.onmessage = (event) => show("echo", "echo " + event.data);
`;

/** A site that expects to own "/": root-relative files, an API, a cookie and a WebSocket. */
const SERVER = `
const page = (title: string, body: string) =>
  new Response("<!doctype html><html><head><title>" + title + "</title><link rel='stylesheet' href='/style.css'><script src='/probe.js'></script></head><body>" + body + "<script src='/app.js'></script></body></html>", {
    headers: { "content-type": "text/html; charset=utf-8", "set-cookie": "visit=1; Path=/; HttpOnly" },
  });
const script = (name: string) => new Response(Bun.file(name), { headers: { "content-type": "text/javascript" } });
const HOME = "<h1>Hello from Bun.serve</h1><a id='about' href='/about'>About</a> <button id='push'>Push</button>" +
  "<p id='where'></p><p id='api'></p><p id='ide'></p><p id='echo'></p>";

Bun.serve({
  port: 3000,
  fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") return server.upgrade(request) ? undefined : new Response("no upgrade", { status: 400 });
    if (url.pathname === "/style.css") return new Response("h1 { color: rgb(1, 2, 3); }", { headers: { "content-type": "text/css" } });
    if (url.pathname === "/app.js" || url.pathname === "/probe.js") return script(url.pathname.slice(1));
    if (url.pathname === "/api/who") return Response.json({ host: request.headers.get("host"), cookie: request.headers.get("cookie") });
    if (url.pathname === "/about") return page("About", "<h1>About page</h1><a id='home' href='/'>Home</a>");
    return page("Home", HOME);
  },
  websocket: {
    message(socket, message) {
      socket.send(String(message).toUpperCase());
    },
  },
});
`;

/** Another workspace's server on the same port. */
const OTHER_SERVER = `
Bun.serve({
  port: 3000,
  fetch: (request) =>
    new URL(request.url).pathname === "/probe.js"
      ? new Response(Bun.file("probe.js"), { headers: { "content-type": "text/javascript" } })
      : new Response("<!doctype html><title>Other</title><script src='/probe.js'></script><h1>Other workspace</h1>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
});
`;

const urlBar = (page: Page) => page.getByTestId("preview-url");
const frameSrc = (page: Page) => page.getByTestId("preview-frame").getAttribute("src");
const heading = (page: Page, text: string, frame?: string) => expectPreviewText(page, "h1", text, { frame });

/** The preview host of a port: 52 characters derived from the workspace, the port, the marker. */
const hostOf = (port: number) => new RegExp(`^[a-z2-7]{52}-${port}-pv\\.localhost:${TWO_BUILDS_PORT}$`);

async function writeSite(page: Page): Promise<void> {
  await writeFile(page, "probe.js", PROBE);
  await writeFile(page, "app.js", APP);
  await writeFile(page, "server.ts", SERVER);
}

async function serve(page: Page): Promise<string> {
  const id = await newWorkspace(page);
  await writeSite(page);
  await runInTerminal(page, "bun server.ts");
  await expect(page.getByTestId("preview-port")).toHaveValue("3000");
  await heading(page, "Hello from Bun.serve");
  return id;
}

async function navigate(page: Page, path: string): Promise<void> {
  await urlBar(page).fill(path);
  await urlBar(page).press("Enter");
}

test("a server gets an origin of its own, where the app owns the root and cannot reach the IDE", async ({
  page,
}) => {
  await serve(page);
  const origin = new URL((await frameSrc(page)) ?? "");
  expect(origin.protocol).toBe("http:");
  expect(origin.host).toMatch(hostOf(3000));
  expect(origin.pathname).toBe("/");

  // The page is where the frame was sent: at the root of the preview's own origin.
  await expectPreviewText(page, "#where", origin.origin);
  // Root-relative files and requests reach the server, which is told the preview's host name
  // and gets back the cookie it set, though the cookie is HttpOnly and never in the page.
  await expect
    .poll(() => inPreview(page, () => getComputedStyle(document.querySelector("h1")!).color))
    .toBe("rgb(1, 2, 3)");
  await expectPreviewText(page, "#api", `host ${origin.host} cookie visit=1`);
  expect(await inPreview(page, () => document.cookie)).toBe("");
  // A WebSocket to the page's own host reaches the server too.
  await expectPreviewText(page, "#echo", "echo PING");
  // The IDE around the frame is another origin: its storage is out of reach.
  await expectPreviewText(page, "#ide", "blocked");
  // And nothing of the previews is registered on the IDE's own origin.
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
});

test("the toolbar drives a preview on its own origin", async ({ page }) => {
  await serve(page);
  await expect(urlBar(page)).toHaveValue("/");
  await expect(page.getByRole("button", { name: "Back" })).toBeDisabled();

  // The URL bar navigates, and a link inside the page moves the URL bar.
  await navigate(page, "about");
  await heading(page, "About page");
  await expect(urlBar(page)).toHaveValue("/about");
  await clickInPreview(page, "#home");
  await heading(page, "Hello from Bun.serve");
  await expect(urlBar(page)).toHaveValue("/");

  // The app's own router owns the address: a pushed state shows in the URL bar as it is.
  await clickInPreview(page, "#push");
  await expect(urlBar(page)).toHaveValue("/pushed?x=1");

  await page.getByRole("button", { name: "Back" }).click();
  await expect(urlBar(page)).toHaveValue("/");
  await page.getByRole("button", { name: "Back" }).click();
  await heading(page, "About page");
  await page.getByRole("button", { name: "Forward" }).click();
  await heading(page, "Hello from Bun.serve");

  // Reload asks the server again and stays on the page, also when the address ends in a
  // fragment, which a frame sent to the same address would only scroll to.
  await navigate(page, "/about#team");
  await heading(page, "About page");
  await expect(urlBar(page)).toHaveValue("/about#team");
  await inPreview(page, () => void document.body.setAttribute("data-stale", ""));
  await page.getByRole("button", { name: "Reload preview" }).click();
  await expect.poll(() => inPreview(page, () => document.body.hasAttribute("data-stale"))).toBe(false);
  await heading(page, "About page");
  await expect(urlBar(page)).toHaveValue("/about");
  // None of it left the workbench.
  await expect(page).toHaveURL(/\/w\/[a-z0-9]+$/);
});

test("open in new tab goes through a page of the IDE; the preview host refuses a tab of its own", async ({
  page,
  context,
}) => {
  await serve(page);
  await navigate(page, "/about");
  await heading(page, "About page");
  const preview = new URL((await frameSrc(page)) ?? "");

  const opened = context.waitForEvent("page");
  await page.getByTestId("preview-open").click();
  const tab = await opened;
  await heading(tab, "About page", "iframe");
  // The tab is on the IDE's origin, names the preview it shows, and takes the preview's title.
  const address = new URL(tab.url());
  expect(address.origin).toBe(TWO_BUILDS_ORIGIN);
  expect(address.pathname).toBe("/preview-frame");
  expect(address.searchParams.get("url")).toBe(`${preview.origin}/about`);
  await expect(tab).toHaveTitle("About");
  // It keeps no way back to the workbench that opened it, and runs none of the app.
  expect(await tab.evaluate(() => window.opener)).toBeNull();
  await expect(tab.getByTestId("workbench")).toHaveCount(0);

  // The preview host itself answers a tab of its own with a refusal, never with the app's page.
  const direct = await context.newPage();
  const response = await direct.goto(`${preview.origin}/about`);
  expect(response?.status()).toBe(403);
  await expect(direct.getByRole("status")).toContainText("only works inside its IDE tab");
  await expect(direct.getByRole("heading")).toHaveCount(0);
});

test("the wrapper page frames nothing but a preview of this build", async ({ page }) => {
  for (const url of ["https://example.com/", `${TWO_BUILDS_ORIGIN}/`, "javascript:alert(1)", ""]) {
    // One address after the other, each on the page the one before left.
    // oxlint-disable-next-line no-await-in-loop
    await page.goto(`/preview-frame?url=${encodeURIComponent(url)}`);
    // oxlint-disable-next-line no-await-in-loop
    await expect(page.getByRole("status")).toBeVisible();
    // oxlint-disable-next-line no-await-in-loop
    await expect(page.locator("iframe")).toHaveCount(0);
  }
});

test("two workspaces on the same port have different origins and never see each other's server", async ({
  page,
  context,
}) => {
  await serve(page);
  const first = new URL((await frameSrc(page)) ?? "");

  const other = await context.newPage();
  await newWorkspace(other);
  await writeFile(other, "probe.js", PROBE);
  await writeFile(other, "server.ts", OTHER_SERVER);
  await runInTerminal(other, "bun server.ts");
  await heading(other, "Other workspace");
  const second = new URL((await frameSrc(other)) ?? "");
  expect(second.host).toMatch(hostOf(3000));
  expect(second.origin).not.toBe(first.origin);
  // The first workspace's page is still its own.
  await page.getByRole("button", { name: "Reload preview" }).click();
  await heading(page, "Hello from Bun.serve");
  await expectPreviewText(page, "#where", first.origin);
});

test("a program in a workspace cannot choose its preview origin", async ({ page, context }) => {
  // An earlier version kept the identity in this file, inside the workspace, where every
  // program can write. Two workspaces that write the same value there must still be apart.
  const forged = "11111111-1111-4111-8111-111111111111";
  const start = `mkdir -p /.sprockt && echo ${forged} > /.sprockt/preview-identity && bun server.ts`;

  await newWorkspace(page);
  await writeSite(page);
  await runInTerminal(page, start);
  await heading(page, "Hello from Bun.serve");
  const first = new URL((await frameSrc(page)) ?? "");

  const other = await context.newPage();
  await newWorkspace(other);
  await writeFile(other, "probe.js", PROBE);
  await writeFile(other, "server.ts", OTHER_SERVER);
  await runInTerminal(other, start);
  await heading(other, "Other workspace");
  const second = new URL((await frameSrc(other)) ?? "");

  expect(first.host).toMatch(hostOf(3000));
  expect(second.host).toMatch(hostOf(3000));
  expect(second.origin).not.toBe(first.origin);
  // Each still shows its own server, with its own cookie jar.
  await page.getByRole("button", { name: "Reload preview" }).click();
  await heading(page, "Hello from Bun.serve");
  await expectPreviewText(page, "#api", `host ${first.host} cookie visit=1`);
  await heading(other, "Other workspace");
});

test("a workspace deleted and created again under the same id gets a new preview origin", async ({
  page,
  context,
  browserName,
}) => {
  // What is tested is which record the IDE keeps and when it forgets it, which no engine does
  // differently. The test navigates one tab four times, and in CI Playwright's WebKit once
  // never finished one of those (`page.goto` timed out after four minutes; the driver's
  // navigation hang on pages with an opener policy, entry 32 of the upstream bug list). It
  // passes in WebKit locally.
  test.skip(browserName === "webkit", "Playwright's WebKit can hang in page.goto; run in the other two");
  const id = await serve(page);
  const before = await frameSrc(page);
  await page.close();

  // Deleted from the landing page, once its tab is gone.
  const landing = await context.newPage();
  await landing.goto("/");
  await expect
    .poll(async () => {
      await landing.reload();
      await expect(landing.getByTestId(`workspace-row-${id}`)).toBeVisible();
      return landing.getByTestId(`workspace-live-${id}`).count();
    })
    .toBe(0);
  await landing.getByTestId(`workspace-row-${id}`).hover();
  await landing.getByTestId(`workspace-delete-${id}`).click();
  await landing.getByTestId(`workspace-delete-confirm-${id}`).click();
  await expect(landing.getByTestId(`workspace-row-${id}`)).toHaveCount(0);

  // The same id again is a new workspace: it must not get its predecessor's origin, where
  // that one's pages left their storage and their cookies.
  await landing.goto(`/w/${id}`);
  await writeSite(landing);
  await runInTerminal(landing, "bun server.ts");
  await heading(landing, "Hello from Bun.serve");
  const after = await frameSrc(landing);
  expect(new URL(after ?? "").host).toMatch(hostOf(3000));
  expect(after).not.toBe(before);
});

test("a second tab of the workspace previews the first tab's server on the same origin", async ({ page }) => {
  test.skip(TAB_POLICY !== "attach", "tabs share a workspace only with the attach policy");
  const id = await newWorkspace(page);
  await writeSite(page);
  // The dev server task: the tab that runs it tells the workspace's other tabs its ports.
  await page.getByTestId("preview-task").click();
  await heading(page, "Hello from Bun.serve");

  const second = await page.context().newPage();
  await second.goto(`/w/${id}`);
  await expect(second.getByTestId("preview-port")).toHaveValue("3000");
  await heading(second, "Hello from Bun.serve");
  // Both tabs derive the same host from the workspace, and the second one's page is served by
  // the first tab's server, cookie and all.
  expect(await frameSrc(second)).toBe(await frameSrc(page));
  const host = new URL((await frameSrc(second)) ?? "").host;
  await expectPreviewText(second, "#api", `host ${host} cookie visit=1`);
  await expectPreviewText(second, "#echo", "echo PING");
});

test("a workspace opened again keeps its preview origin, and so its cookies", async ({ page, context }) => {
  const id = await serve(page);
  const before = await frameSrc(page);
  // Closed and opened in a new tab, not reloaded: Playwright's Firefox never commits a
  // navigation of a tab that holds a preview origin's relay frame (ARCHITECTURE.md "Known gaps").
  await page.close();
  const again = await context.newPage();
  await again.goto(`/w/${id}`);
  await runInTerminal(again, "bun server.ts");
  await heading(again, "Hello from Bun.serve");
  expect(await frameSrc(again)).toBe(before);
  // The server is a new process; the cookie its predecessor set came back from the IDE's jar.
  await expectPreviewText(again, "#api", `host ${new URL(before ?? "").host} cookie visit=1`);
});
