import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, newWorkspace, test, writeFile } from "./helpers";
import { TWO_BUILDS_ORIGIN } from "./origins";
import { clickInPreview, expectPreviewText, inPreview, PROBE } from "./preview-probe";
import { BUILD_COOKIE } from "../scripts/serve-builds";

/** The Vite + React starter that bun-wasm tests against, read from the installed package. */
const TEMPLATE = join(import.meta.dirname, "../node_modules/bun-wasm/sandbox/template");

function templateFiles(): Record<string, string> {
  const names = readdirSync(TEMPLATE, { recursive: true, encoding: "utf8" });
  const files = names.filter((name) => statSync(join(TEMPLATE, name)).isFile());
  return Object.fromEntries(files.map((name) => [name, readFileSync(join(TEMPLATE, name), "utf8")]));
}

async function writeFiles(page: Page, files: Record<string, string>): Promise<void> {
  await page.waitForFunction(() => globalThis.sprockt?.workspace !== undefined);
  await page.evaluate((all) => globalThis.sprockt?.workspace?.files.writeMany(all), files);
}

const frame = (page: Page) => page.frameLocator("[data-testid=preview-frame]");

test("Vite hot reload: an edit shows in the preview and the page keeps its state", async ({ page }) => {
  // Installing React and Vite from the registry inside the browser takes a while: these are
  // hang caps for a download, not speed targets.
  test.setTimeout(900_000);
  const patient = { timeout: 600_000 };

  await newWorkspace(page);
  const files = templateFiles();
  await writeFiles(page, files);

  // The pane's button finds the dev script, installs what is missing and starts the server.
  await page.getByTestId("preview-task").click();
  await expect(page.getByTestId("preview-port")).toHaveValue("5173", patient);
  await expect(page.getByTestId("preview-task")).toHaveAttribute("data-status", "running");
  // The title bar's pill prints the port the way the picker does.
  await expect(page.getByTestId("dev-server")).toHaveText(":5173");

  const app = frame(page);
  await expect(app.getByRole("heading")).toHaveText("Hello from bun.wasm", patient);
  const counter = app.getByRole("button", { name: /count is/ });
  await counter.click();
  await counter.click();
  await expect(counter).toHaveText("count is 2");

  // An edit through the file service, as the editor makes it.
  const source = files["src/App.tsx"] ?? "";
  await writeFile(page, "src/App.tsx", source.replace("Hello from bun.wasm", "Edited while running"));
  await expect(app.getByRole("heading")).toHaveText("Edited while running", patient);
  // The counter kept its value: the module was swapped in place, the page was not reloaded.
  await expect(counter).toHaveText("count is 2");

  // The pill's stop button stops the server the pane started, and the pill goes away.
  await page.getByTestId("dev-server").getByRole("button", { name: "Stop dev server" }).click();
  await expect(page.getByTestId("preview-task")).toHaveAttribute("data-status", "stopped");
  await expect(page.getByTestId("preview-port")).toHaveCount(0);
  await expect(page.getByTestId("dev-server")).toHaveCount(0);
});

test.describe("on a preview origin of its own", () => {
  // The build with isolated previews (e2e/isolated-preview.spec.ts): Vite serves at the root of
  // its own origin, and its hot-reload socket travels through that origin's service worker.
  test.use({ baseURL: TWO_BUILDS_ORIGIN });

  test("Vite hot reload: an edit shows in the preview and the page keeps its state", async ({
    page,
    context,
  }) => {
    test.setTimeout(900_000);
    const patient = { timeout: 600_000 };
    await context.addCookies([{ name: BUILD_COOKIE, value: "isolated", url: TWO_BUILDS_ORIGIN }]);

    await newWorkspace(page);
    // The same starter, with the probe the test reads the page through (preview-probe.ts).
    const files = templateFiles();
    const html = (files["index.html"] ?? "").replace("</head>", '<script src="/probe.js"></script></head>');
    await writeFiles(page, { ...files, "index.html": html, "public/probe.js": PROBE });

    await page.getByTestId("preview-task").click();
    await expect(page.getByTestId("preview-port")).toHaveValue("5173", patient);
    const address = new URL((await page.getByTestId("preview-frame").getAttribute("src")) ?? "");
    expect(address.host).toMatch(/^[a-z2-7]{52}-5173-pv\.localhost:\d+$/);
    await expectPreviewText(page, "h1", "Hello from bun.wasm", patient);
    // Vite was asked under the preview's host name and served its page at the root.
    expect(await inPreview(page, () => location.pathname)).toBe("/");

    await clickInPreview(page, "button");
    await clickInPreview(page, "button");
    await expectPreviewText(page, "button", "count is 2");

    const source = files["src/App.tsx"] ?? "";
    await writeFile(page, "src/App.tsx", source.replace("Hello from bun.wasm", "Edited while running"));
    await expectPreviewText(page, "h1", "Edited while running", patient);
    // The counter kept its value: the module was swapped in place, the page was not reloaded.
    await expectPreviewText(page, "button", "count is 2");
  });
});
