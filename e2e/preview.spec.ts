import type { Page } from "@playwright/test";
import { expect, newWorkspace, runInTerminal, test, writeFile } from "./helpers";
import { PREVIEWS_OFF } from "../src/preview/host-protocol";
import { TAB_POLICY } from "../src/runtime/tab-policy";

/**
 * A small site served by Bun.serve: links, an error button, a WebSocket echo that counts its open
 * connections, and redirects that try to leave the server.
 */
const SERVER = `
const page = (title: string, body: string) =>
  new Response("<!doctype html><html><head><title>" + title + "</title></head><body>" + body + "</body></html>", {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });
let sockets = 0;

Bun.serve({
  port: 3000,
  fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") return server.upgrade(request) ? undefined : new Response("no upgrade", { status: 400 });
    if (url.pathname === "/about") return page("About", "<h1>About page</h1><a href='/'>Home</a>");
    if (url.pathname === "/sockets") return page("Sockets", "<h1>open sockets: " + sockets + "</h1>");
    if (url.pathname === "/old/place") return redirect("/about");
    if (url.pathname === "/deep/inside/up") return redirect("../../../../../about");
    if (url.pathname === "/to-other-port") return redirect("/../5174/about");
    if (url.pathname === "/echo") return page("Echo", "<h1 id='echo'>waiting</h1><script>const socket = new WebSocket('ws://' + location.host + '/ws'); socket.onopen = () => socket.send('ping'); socket.onmessage = (event) => { document.getElementById('echo').textContent = 'echo: ' + event.data; };</script>");
    return page("Home", "<h1>Hello from Bun.serve</h1><a href='/about'>About</a><button id='boom' onclick='console.error(\\"kaboom\\")'>Boom</button>");
  },
  websocket: {
    open() {
      sockets++;
    },
    close() {
      sockets--;
    },
    message(socket, message) {
      socket.send(String(message).toUpperCase());
    },
  },
});
`;

const frame = (page: Page) => page.frameLocator("[data-testid=preview-frame]");
const urlBar = (page: Page) => page.getByTestId("preview-url");

async function navigate(page: Page, path: string): Promise<void> {
  await urlBar(page).fill(path);
  await urlBar(page).press("Enter");
}

test.beforeEach(({ browserName }) => {
  // Every preview needs a server, and Bun's browser engine traps in Playwright's WebKit
  // (ARCHITECTURE.md "Known gaps"). Remove when Bun runs there.
  test.fixme(browserName === "webkit", "Bun's browser engine traps in WebKit");
});

test("a server started in the terminal shows in the preview, and the toolbar drives it", async ({ page }) => {
  await newWorkspace(page);
  await expect(page.getByTestId("preview-empty")).toBeVisible();
  await expect(page.getByTestId("preview-port")).toBeDisabled();
  await writeFile(page, "server.ts", SERVER);
  await runInTerminal(page, "bun server.ts");

  await expect(page.getByTestId("preview-port")).toHaveValue("3000");
  // The port prints the same way in the picker and in the title bar's pill. A server started in
  // the terminal is stopped there, so the pill has no stop button for it.
  await expect(page.getByTestId("preview-port").locator("option:checked")).toHaveText(":3000");
  await expect(page.getByTestId("dev-server")).toHaveText(":3000");
  await expect(page.getByTestId("dev-server").getByRole("button")).toHaveCount(1);
  await expect(frame(page).getByRole("heading")).toHaveText("Hello from Bun.serve");
  await expect(urlBar(page)).toHaveValue("/");
  await expect(page.getByRole("button", { name: "Back" })).toBeDisabled();

  // The URL bar navigates, with or without the leading slash.
  await navigate(page, "about");
  await expect(frame(page).getByRole("heading")).toHaveText("About page");
  await expect(urlBar(page)).toHaveValue("/about");

  // A link inside the page moves the URL bar too.
  await frame(page).getByRole("link", { name: "Home" }).click();
  await expect(urlBar(page)).toHaveValue("/");

  await page.getByRole("button", { name: "Back" }).click();
  await expect(frame(page).getByRole("heading")).toHaveText("About page");
  await page.getByRole("button", { name: "Forward" }).click();
  await expect(frame(page).getByRole("heading")).toHaveText("Hello from Bun.serve");
  await expect(page.getByRole("button", { name: "Forward" })).toBeDisabled();
  // Going back and forth never left the workbench.
  await expect(page).toHaveURL(/\/w\/[a-z0-9]+$/);
});

test("typed paths and the server's redirects stay on the server they belong to", async ({ page }) => {
  const id = await newWorkspace(page);
  await writeFile(page, "server.ts", SERVER);
  await runInTerminal(page, "bun server.ts");
  await expect(frame(page).getByRole("heading")).toHaveText("Hello from Bun.serve");
  const mount = `/__preview/${id}/3000`;
  const framePath = () =>
    frame(page)
      .locator("html")
      .evaluate(() => location.pathname);

  // A path that climbs is resolved on the server, as in its own address bar: it cannot reach
  // another port's mount, another workspace's, or the IDE.
  await navigate(page, "/../5174/about");
  await expect(urlBar(page)).toHaveValue("/5174/about");
  await expect(page.getByTestId("preview-port")).toHaveValue("3000");
  expect(await framePath()).toBe(`${mount}/5174/about`);
  await navigate(page, "/%2e%2e/%2e%2e/%2e%2e/about");
  await expect(frame(page).getByRole("heading")).toHaveText("About page");
  await expect(urlBar(page)).toHaveValue("/about");

  // A redirect to a path on the server, and one that climbs past the server's root. Each starts
  // from the home page, so that arriving at the About page is the redirect's doing.
  await navigate(page, "/");
  await expect(frame(page).getByRole("heading")).toHaveText("Hello from Bun.serve");
  await navigate(page, "/old/place");
  await expect(frame(page).getByRole("heading")).toHaveText("About page");
  await expect(urlBar(page)).toHaveValue("/about");
  await navigate(page, "/");
  await expect(frame(page).getByRole("heading")).toHaveText("Hello from Bun.serve");
  await navigate(page, "/deep/inside/up");
  await expect(frame(page).getByRole("heading")).toHaveText("About page");
  await expect(urlBar(page)).toHaveValue("/about");
  expect(await framePath()).toBe(`${mount}/about`);

  // A redirect aimed at another port's mount ends on this server.
  await navigate(page, "/to-other-port");
  await expect(urlBar(page)).toHaveValue("/5174/about");
  await expect(page.getByTestId("preview-port")).toHaveValue("3000");
  expect(await framePath()).toBe(`${mount}/5174/about`);
  await expect(page).toHaveURL(/\/w\/[a-z0-9]+$/);
});

test("reload, the error indicator and the viewport switch", async ({ page }) => {
  await newWorkspace(page);
  await writeFile(page, "server.ts", SERVER);
  await runInTerminal(page, "bun server.ts");
  await expect(frame(page).getByRole("heading")).toHaveText("Hello from Bun.serve");

  await expect(page.getByTestId("preview-errors")).toBeHidden();
  await frame(page).getByRole("button", { name: "Boom" }).click();
  await expect(page.getByTestId("preview-errors")).toHaveText("1");
  await page.getByTestId("preview-errors").click();
  await expect(page.getByTestId("preview-error-list")).toContainText("kaboom");

  // A reload loads the page again, and a fresh page has no errors yet.
  await frame(page)
    .getByRole("heading")
    .evaluate((heading) => (heading.textContent = "changed in place"));
  await page.getByRole("button", { name: "Reload preview" }).click();
  await expect(frame(page).getByRole("heading")).toHaveText("Hello from Bun.serve");
  await expect(page.getByTestId("preview-errors")).toBeHidden();

  const width = () =>
    page.getByTestId("preview-frame").evaluate((element) => element.getBoundingClientRect().width);
  await page.getByRole("button", { name: "Phone viewport" }).click();
  expect(await width()).toBe(390);
  await page.getByRole("button", { name: "Tablet viewport" }).click();
  expect(await width()).toBe(768);
  // The desktop size is the pane's own width, whatever the layout gives it; the other two are
  // fixed, and scroll inside a pane that is narrower.
  const stage = () => page.locator(".preview-stage").evaluate((element) => element.clientWidth);
  await page.getByRole("button", { name: "Desktop viewport" }).click();
  expect(await width()).toBeCloseTo(await stage(), 0);
  expect(await width()).not.toBe(768);
});

test("the pane's button starts a server entry file, and the pill stops it", async ({ page }) => {
  await newWorkspace(page);
  // A script with no import or export and with WebSocket handlers: the kind of file `bun --hot`
  // refuses in bun-wasm. The task runs it with plain `bun`.
  await writeFile(page, "server.ts", SERVER);
  const task = page.getByTestId("preview-task");
  await expect(task).toHaveAttribute("data-status", "stopped");
  await task.click();
  await expect(frame(page).getByRole("heading")).toHaveText("Hello from Bun.serve");
  await expect(task).toHaveAttribute("data-status", "running");
  await expect(page.getByTestId("dev-server")).toHaveText(":3000");
  await navigate(page, "/echo");
  await expect(frame(page).getByRole("heading")).toHaveText("echo: PING");

  // An edit shows without anyone restarting anything: the task runs the file again.
  await writeFile(page, "server.ts", SERVER.replace("Hello from Bun.serve", "Edited and restarted"));
  await expect(frame(page).getByRole("heading")).toHaveText("Edited and restarted");
  await expect(task).toHaveAttribute("data-status", "running");
  // What the server writes itself is not a reason to restart it.
  await writeFile(page, "data.json", "{}");
  await writeFile(page, "notes.sqlite", "not source");
  await expect(page.getByTestId("save-state")).toHaveText("saved");
  await expect(task).toHaveAttribute("data-status", "running");
  await expect(frame(page).getByRole("heading")).toHaveText("Edited and restarted");

  await page.getByTestId("dev-server").getByRole("button", { name: "Stop dev server" }).click();
  await expect(task).toHaveAttribute("data-status", "stopped");
  await expect(page.getByTestId("preview-port")).toBeDisabled();
  await expect(page.getByTestId("dev-server")).toHaveCount(0);

  // It starts again, from the pane's button, and that button stops it too.
  await task.click();
  await expect(frame(page).getByRole("heading")).toHaveText("Edited and restarted");
  await task.click();
  await expect(task).toHaveAttribute("data-status", "stopped");
  // Stopped is stopped: an edit now starts nothing.
  await writeFile(page, "server.ts", SERVER);
  await expect(page.getByTestId("save-state")).toHaveText("saved");
  await expect(task).toHaveAttribute("data-status", "stopped");
  await expect(page.getByTestId("preview-port")).toBeDisabled();
});

test("the Bun.serve + bun:sqlite starter starts from the pane's button and renders", async ({ page }) => {
  // The starter installs Bun's types from the npm registry inside the browser first: these are
  // hang caps for a download, not speed targets.
  test.setTimeout(900_000);
  const patient = { timeout: 600_000 };
  await page.goto("/");
  await page.getByTestId("template-bun-sqlite").click();
  await expect(page).toHaveURL(/\/w\/[a-z0-9-]+$/);
  await expect(page.getByTestId("terminal-state")).toHaveText("ready");

  await page.getByTestId("preview-task").click();
  const app = frame(page);
  await expect(app.getByRole("heading")).toHaveText("Bun.serve + bun:sqlite", patient);
  await expect(page.getByTestId("preview-port")).toHaveValue("5173");
  // The page is rendered from rows the server put in its database.
  await expect(app.getByText("SQLite persists inside IndexedDB")).toBeVisible();

  // A form post writes a row, and the redirect back stays in the preview.
  await app.getByPlaceholder("Write a note...").fill("written from the preview");
  await app.getByRole("button", { name: "Add" }).click();
  await expect(app.getByText("written from the preview")).toBeVisible();
  await expect(urlBar(page)).toHaveValue("/");
  await expect(page.getByTestId("preview-task")).toHaveAttribute("data-status", "running");
});

test("a tab that takes the workspace over is not left following the old tab's dev server", async ({
  page,
  context,
}) => {
  // With the attach policy a second tab shares the workspace instead (e2e/dev-server-tabs.spec.ts).
  test.skip(TAB_POLICY === "attach", "a second tab takes over only with the takeover policy");
  const id = await newWorkspace(page);
  await writeFile(page, "server.ts", SERVER);
  await expect(page.getByTestId("save-state")).toHaveText("saved");
  await page.getByTestId("preview-task").click();
  await expect(frame(page).getByRole("heading")).toHaveText("Hello from Bun.serve");

  const second = await context.newPage();
  await second.goto(`/w/${id}`);
  await second.getByTestId("take-over").click();
  await expect(page.getByTestId("workbench")).toHaveAttribute("data-stage", "moved");

  // The old tab's server went with its runtime: the new tab shows none, and can start its own.
  const task = second.getByTestId("preview-task");
  await expect(task).toHaveAttribute("data-status", "stopped");
  await expect(task).toBeEnabled();
  await expect(second.getByTestId("preview-port")).toBeDisabled();
  await task.click();
  await expect(frame(second).getByRole("heading")).toHaveText("Hello from Bun.serve");
  await expect(task).toHaveAttribute("data-status", "running");
  await expect(task).toBeEnabled();
});

test("on a phone the toolbar keeps open in new tab, and fades only where it overflows", async ({ page }) => {
  await newWorkspace(page);
  await writeFile(page, "server.ts", SERVER);
  await runInTerminal(page, "bun server.ts");
  await expect(frame(page).getByRole("heading")).toHaveText("Hello from Bun.serve");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId("pane-switcher").getByRole("button", { name: "Preview" }).click();
  const scroller = page.getByTestId("preview-bar-scroll");
  await expect(page.getByTestId("preview-open")).toBeInViewport({ ratio: 1 });
  // The toolbar fits, so neither edge fades.
  await expect(scroller).toHaveAttribute("data-fade", "");

  // Too narrow for the whole toolbar: it scrolls, the fade is on the side with more to see, and
  // the button is still there.
  await page.setViewportSize({ width: 280, height: 844 });
  await expect(scroller).toHaveAttribute("data-fade", "end");
  await expect(page.getByTestId("preview-open")).toBeInViewport({ ratio: 1 });
  await scroller.evaluate((element) => element.scrollTo({ left: element.scrollWidth }));
  await expect(scroller).toHaveAttribute("data-fade", "start");
});

test("a WebSocket in the previewed page reaches the server", async ({ page }) => {
  await newWorkspace(page);
  await writeFile(page, "server.ts", SERVER);
  await runInTerminal(page, "bun server.ts");
  await expect(frame(page).getByRole("heading")).toHaveText("Hello from Bun.serve");
  await navigate(page, "/echo");
  await expect(frame(page).getByRole("heading")).toHaveText("echo: PING");
});

test("reloading or leaving a page closes its WebSockets on the server", async ({ page }) => {
  await newWorkspace(page);
  await writeFile(page, "server.ts", SERVER);
  await runInTerminal(page, "bun server.ts");
  await expect(frame(page).getByRole("heading")).toHaveText("Hello from Bun.serve");
  await navigate(page, "/echo");
  await expect(frame(page).getByRole("heading")).toHaveText("echo: PING");

  // Three reloads: each page opens a socket, and each one before it has to go.
  const reload = page.getByRole("button", { name: "Reload preview" });
  const reloadEcho = async () => {
    await frame(page)
      .getByRole("heading")
      .evaluate((heading) => (heading.textContent = "reloading"));
    await reload.click();
    await expect(frame(page).getByRole("heading")).toHaveText("echo: PING");
  };
  await reloadEcho();
  await reloadEcho();
  await reloadEcho();

  // Leaving for a page without a socket: the server ends up with none open. The page shows the
  // count as it was when it was served, so it is asked again until the last close has landed.
  await navigate(page, "/sockets");
  await expect(async () => {
    await reload.click();
    await expect(frame(page).getByRole("heading")).toHaveText("open sockets: 0", { timeout: 2000 });
  }).toPass({ timeout: 60_000 });
});

test("the preview opens in its own tab", async ({ page, context }) => {
  await newWorkspace(page);
  await writeFile(page, "server.ts", SERVER);
  await runInTerminal(page, "bun server.ts");
  await expect(frame(page).getByRole("heading")).toHaveText("Hello from Bun.serve");
  await navigate(page, "/about");
  await expect(urlBar(page)).toHaveValue("/about");

  const opened = context.waitForEvent("page");
  await page.getByTestId("preview-open").click();
  const tab = await opened;
  await expect(tab.getByRole("heading")).toHaveText("About page");
  expect(new URL(tab.url()).pathname).toMatch(/^\/__preview\/[a-z0-9]+\/3000\/about$/);
  // On its own in a tab the page is as isolated as in the frame, so it has SharedArrayBuffer.
  expect(await tab.evaluate(() => crossOriginIsolated)).toBe(true);
  expect(await tab.evaluate(() => typeof SharedArrayBuffer)).toBe("function");
});

test("a worker told that previews are off stops serving, with the hosting tab still open", async ({
  page,
  context,
}) => {
  const id = await newWorkspace(page);
  await writeFile(page, "server.ts", SERVER);
  await runInTerminal(page, "bun server.ts");
  await expect(frame(page).getByRole("heading")).toHaveText("Hello from Bun.serve");
  const address = `/__preview/${id}/3000/`;
  const direct = await context.newPage();
  await direct.goto(address);
  await expect(direct.getByRole("heading")).toHaveText("Hello from Bun.serve");
  await direct.close();

  // What a page of a build without previews sends (src/preview/retire.ts), sent by hand here.
  const other = await context.newPage();
  await other.goto("/");
  await other.evaluate(async (type) => {
    const registrations = await navigator.serviceWorker.getRegistrations();
    for (const registration of registrations) registration.active?.postMessage({ type });
  }, PREVIEWS_OFF);
  // The worker removed its own registration.
  await expect
    .poll(() => other.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length))
    .toBe(0);

  // The tab that hosts the server is still open, and the address no longer reaches it.
  await expect(page.getByTestId("workbench")).toHaveAttribute("data-stage", "ready");
  const visit = await context.newPage();
  await visit.goto(address);
  await expect(visit.locator("#app")).toBeAttached();
  await expect(visit.getByText("Hello from Bun.serve")).toHaveCount(0);
  expect(await visit.evaluate(() => navigator.serviceWorker.controller)).toBeNull();
});

test("a dev command that fails leaves its output on screen", async ({ page }) => {
  await newWorkspace(page);
  await writeFile(page, "package.json", JSON.stringify({ scripts: { dev: "bun not-there.ts" } }));
  // With a node_modules folder the task runs the script without installing first.
  await writeFile(page, "node_modules/.keep", "");
  await expect(page.getByTestId("save-state")).toHaveText("saved");
  const task = page.getByTestId("preview-task");
  await task.click();
  await expect(page.getByTestId("preview-task-output")).toContainText("not-there.ts");
  // The command ended, and what it said is still there.
  await expect(task).toHaveAttribute("data-status", "stopped");
  await expect(page.getByTestId("preview-task-output")).toContainText("not-there.ts");
  // As text: the terminal's colour codes are not printed.
  expect(await page.getByTestId("preview-task-output").textContent()).not.toContain("\u001B");
  await expect(page.getByTestId("dev-server")).toHaveCount(0);
});

test("two workspaces on the same port do not see each other's server", async ({ page, context }) => {
  const first = await newWorkspace(page);
  await writeFile(page, "server.ts", SERVER.replace("Hello from Bun.serve", "First workspace"));
  await runInTerminal(page, "bun server.ts");
  await expect(frame(page).getByRole("heading")).toHaveText("First workspace");

  const other = await context.newPage();
  const second = await newWorkspace(other);
  await writeFile(other, "server.ts", SERVER.replace("Hello from Bun.serve", "Second workspace"));
  await runInTerminal(other, "bun server.ts");
  await expect(frame(other).getByRole("heading")).toHaveText("Second workspace");

  // Each workspace's URL reaches its own server, from either tab.
  const direct = await context.newPage();
  await direct.goto(`/__preview/${first}/3000/`);
  await expect(direct.getByRole("heading")).toHaveText("First workspace");
  await direct.goto(`/__preview/${second}/3000/`);
  await expect(direct.getByRole("heading")).toHaveText("Second workspace");
});
