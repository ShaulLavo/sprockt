import type { Page } from "@playwright/test";
import { expect, newWorkspace, retryLostFrames, runInTerminal, test, writeFile } from "./helpers";

retryLostFrames();

/** A small site with links, an error button and a WebSocket echo, served by Bun.serve. */
const SERVER = `
const page = (title: string, body: string) =>
  new Response("<!doctype html><html><head><title>" + title + "</title></head><body>" + body + "</body></html>", {
    headers: { "content-type": "text/html; charset=utf-8" },
  });

Bun.serve({
  port: 3000,
  fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") return server.upgrade(request) ? undefined : new Response("no upgrade", { status: 400 });
    if (url.pathname === "/about") return page("About", "<h1>About page</h1><a href='/'>Home</a>");
    if (url.pathname === "/echo") return page("Echo", "<h1 id='echo'>waiting</h1><script>const socket = new WebSocket('ws://' + location.host + '/ws'); socket.onopen = () => socket.send('ping'); socket.onmessage = (event) => { document.getElementById('echo').textContent = 'echo: ' + event.data; };</script>");
    return page("Home", "<h1>Hello from Bun.serve</h1><a href='/about'>About</a><button id='boom' onclick='console.error(\\"kaboom\\")'>Boom</button>");
  },
  websocket: {
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
  await page.getByRole("button", { name: "Desktop viewport" }).click();
  expect(await width()).toBeGreaterThan(390);
});

test("a WebSocket in the previewed page reaches the server", async ({ page }) => {
  await newWorkspace(page);
  await writeFile(page, "server.ts", SERVER);
  await runInTerminal(page, "bun server.ts");
  await expect(frame(page).getByRole("heading")).toHaveText("Hello from Bun.serve");
  await navigate(page, "/echo");
  await expect(frame(page).getByRole("heading")).toHaveText("echo: PING");
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
