import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, newWorkspace, retryLostFrames, test, writeFile } from "./helpers";

retryLostFrames();

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

test("Vite hot reload: an edit shows in the preview and the page keeps its state", async ({
  page,
  browserName,
}) => {
  // Bun's browser engine traps in Playwright's WebKit (ARCHITECTURE.md "Known gaps").
  test.fixme(browserName === "webkit", "Bun's browser engine traps in WebKit");
  // Installing React and Vite from the registry inside the browser takes a while: these are
  // hang caps for a download, not speed targets.
  test.setTimeout(900_000);
  const patient = { timeout: 600_000 };

  await newWorkspace(page);
  const files = templateFiles();
  await writeFiles(page, files);

  // The pane's button finds the dev script, installs what is missing and starts the server.
  await page.getByTestId("dev-server").click();
  await expect(page.getByTestId("preview-port")).toHaveValue("5173", patient);
  await expect(page.getByTestId("dev-server")).toHaveAttribute("data-status", "running");

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

  await page.getByTestId("dev-server").click();
  await expect(page.getByTestId("dev-server")).toHaveAttribute("data-status", "stopped");
  await expect(page.getByTestId("preview-port")).toBeDisabled();
});
