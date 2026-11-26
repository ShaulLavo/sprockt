import type { Page } from "@playwright/test";
import { expect, newWorkspace, test, writeFile } from "./helpers";
import { TAB_POLICY } from "../src/runtime/tab-policy";

// One tab of a workspace runs its dev server (src/tasks/dev-server-line.ts); the others show the
// same preview. Tabs share a workspace only with the attach policy; with takeover there is one
// live tab, and e2e/preview.spec.ts and e2e/hmr.spec.ts cover it.
test.skip(TAB_POLICY !== "attach", "tabs share a workspace only with the attach policy");

test.beforeEach(({ browserName }) => {
  // Bun's browser engine traps in Playwright's WebKit (ARCHITECTURE.md "Known gaps").
  test.fixme(browserName === "webkit", "Bun's browser engine traps in WebKit");
});

const SERVER = `
Bun.serve({
  port: 3000,
  fetch: () =>
    new Response("<!doctype html><html><head><title>Home</title></head><body><h1>Shared server</h1></body></html>", {
      headers: { "content-type": "text/html; charset=utf-8" },
    }),
});
`;

const frame = (page: Page) => page.frameLocator("[data-testid=preview-frame]");
const task = (page: Page) => page.getByTestId("preview-task");
const pill = (page: Page) => page.getByTestId("dev-server");

/** A workspace whose first tab runs the dev server, and a second tab on the same workspace. */
async function twoTabs(page: Page): Promise<Page> {
  const id = await newWorkspace(page);
  await writeFile(page, "server.ts", SERVER);
  await task(page).click();
  await expect(frame(page).getByRole("heading")).toHaveText("Shared server");
  const second = await page.context().newPage();
  await second.goto(`/w/${id}`);
  await expect(second.getByTestId("terminal-state")).toHaveText("ready");
  return second;
}

test("a second tab previews the server the first tab runs, and cannot stop it", async ({ page }) => {
  const second = await twoTabs(page);
  await expect(second.getByTestId("preview-port")).toHaveValue("3000");
  await expect(frame(second).getByRole("heading")).toHaveText("Shared server");
  await expect(task(second)).toHaveAttribute("data-status", "running");
  await expect(task(second)).toBeDisabled();
  // The pill shows the port and has no stop button here; the first tab's has one.
  await expect(pill(second)).toHaveText(":3000");
  await expect(pill(second).getByRole("button")).toHaveCount(1);
  await expect(pill(page).getByRole("button")).toHaveCount(2);
});

test("stopping the server in the tab that runs it stops it for both, and nobody restarts it", async ({
  page,
}) => {
  const second = await twoTabs(page);
  await expect(task(second)).toHaveAttribute("data-status", "running");

  await pill(page).getByRole("button", { name: "Stop dev server" }).click();
  await expect(task(page)).toHaveAttribute("data-status", "stopped");
  await expect(task(second)).toHaveAttribute("data-status", "stopped");
  await expect(second.getByTestId("preview-port")).toHaveCount(0);
  // The first tab has let the server go by now; the second one still has not taken it over.
  await expect(task(page)).toBeEnabled();
  await expect(task(second)).toHaveAttribute("data-status", "stopped");

  // The other tab can start it now, and the first one sees that.
  await task(second).click();
  await expect(frame(second).getByRole("heading")).toHaveText("Shared server");
  await expect(task(page)).toBeDisabled();
  await expect(frame(page).getByRole("heading")).toHaveText("Shared server");
});

test("when the tab that runs the server closes, the other tab runs it", async ({ page }) => {
  const second = await twoTabs(page);
  await expect(frame(second).getByRole("heading")).toHaveText("Shared server");

  await page.close();
  await expect(task(second)).toBeEnabled();
  await expect(task(second)).toHaveAttribute("data-status", "running");
  await expect(frame(second).getByRole("heading")).toHaveText("Shared server");
  await expect(pill(second).getByRole("button")).toHaveCount(2);
});
