import type { Page } from "@playwright/test";
import { SELECTORS } from "../selectors.ts";
import { assertCondition, waitForWorkbenchReady, type AgentScenario } from "./types.ts";

async function pollPreviewContent(page: Page, expectedText: string, deadline: number): Promise<string> {
  const taskError = await page
    .locator(SELECTORS.preview.taskOutput)
    .textContent()
    .catch(() => "");
  if (taskError && taskError.includes("Unsupported architecture on Linux: wasm32")) {
    throw new Error(`Dev server crashed with Rolldown wasm32 error:\n${taskError.slice(-400)}`);
  }
  const frameText = await page
    .frameLocator(SELECTORS.preview.frame)
    .locator("body")
    .innerText()
    .catch(() => "");
  if (frameText.includes(expectedText)) return frameText;
  if (Date.now() >= deadline) {
    const output = await page
      .locator(SELECTORS.preview.taskOutput)
      .textContent()
      .catch(() => "");
    throw new Error(
      `Preview never rendered "${expectedText}". Last dev server output:\n${(output ?? "").slice(-600)}`,
    );
  }
  await page.waitForTimeout(300);
  return pollPreviewContent(page, expectedText, deadline);
}

function waitForPreviewContent(page: Page, expectedText: string, timeoutMs: number): Promise<string> {
  return pollPreviewContent(page, expectedText, Date.now() + timeoutMs);
}

export const starterDevServerScenario: AgentScenario = {
  name: "starter-dev-server",
  description:
    "Open a starter (default vite-react), check zero initial LSP red squiggles, click Start dev server, verify live preview + counter + HMR.",
  readOnly: false,
  defaultViewport: "desktop",
  async run(ctx) {
    const { page, baseUrl, args, evidence } = ctx;
    const starterId = args.starter;
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.waitForSelector(SELECTORS.landing.templateCard(starterId));
    await page.locator(SELECTORS.landing.templateCard(starterId)).click();
    await page.waitForURL(/\/w\/[a-z0-9]+$/, { timeout: 30_000 });
    await waitForWorkbenchReady(page, args.timeoutMs);
    await page.waitForSelector(SELECTORS.editor.root, { timeout: 30_000 });
    if (starterId === "vite-react") {
      await page
        .locator(SELECTORS.explorer.tree)
        .getByRole("button", { name: "App.tsx", exact: true })
        .click();
      await page.waitForFunction(
        (sel) => document.querySelector(sel)?.getAttribute("aria-label") === "src/App.tsx",
        SELECTORS.editor.activeFile,
      );
    }
    await page.waitForTimeout(1500);

    const initialSquiggles = await page.locator(SELECTORS.editor.lspErrorSquiggle).count();
    const initialStatus = (await page.locator(SELECTORS.workbench.statusBar).innerText()).trim();
    assertCondition(
      initialSquiggles === 0,
      `Expected 0 false-alarm initial LSP red squiggles before install, found ${initialSquiggles}`,
    );
    await evidence.capture(page, "starter-opened-clean-lsp");
    evidence.notes.push(
      `Opened starter "${starterId}": 0 initial LSP red squiggles (status: "${initialStatus}").`,
    );

    const startBtn = page.locator(SELECTORS.preview.startButton).first();
    await startBtn.waitFor({ state: "visible", timeout: 30_000 });
    await startBtn.click();

    const expectedHeading = starterId === "vite-react" ? "Hello from bun.wasm" : "";
    if (expectedHeading) {
      await waitForPreviewContent(page, expectedHeading, args.timeoutMs);
    } else {
      await page.waitForSelector(SELECTORS.preview.frame, { timeout: args.timeoutMs });
    }
    await evidence.capture(page, "dev-server-rendered");

    if (starterId === "vite-react") {
      const frame = page.frameLocator(SELECTORS.preview.frame);
      await frame.getByRole("button", { name: /count is 0/i }).click();
      await frame.getByRole("button", { name: /count is 1/i }).waitFor({ timeout: 10_000 });
      evidence.notes.push("Preview interactive counter incremented from 0 to 1.");

      await page.locator(SELECTORS.editor.root).click();
      await page.evaluate(() => {
        const current = globalThis.sprockt?.editorText() ?? "";
        if (!current.includes("Hello from bun.wasm")) {
          throw new Error("Expected src/App.tsx to be active in editor");
        }
      });
      const updated = await page.evaluate(async () => {
        const files = globalThis.sprockt?.workspace?.files;
        if (!files) throw new Error("Workspace FileService unavailable");
        const src = await files.read("src/App.tsx");
        if (typeof src !== "string") throw new Error("src/App.tsx could not be read");
        const next = src.replace("Hello from bun.wasm", "Hello from verify-sprockt");
        await files.write("src/App.tsx", next);
        return next.includes("Hello from verify-sprockt");
      });
      assertCondition(updated, "Could not write HMR update to src/App.tsx");
      await waitForPreviewContent(page, "Hello from verify-sprockt", 30_000);
      await page.waitForTimeout(1000);
      const postInstallStatus = (await page.locator(SELECTORS.workbench.statusBar).innerText()).trim();
      assertCondition(
        !postInstallStatus.includes("Install deps for TS"),
        `Expected "Install deps for TS" to clear after bun install, got "${postInstallStatus}"`,
      );
      await evidence.capture(page, "hmr-updated");
      evidence.notes.push("Edited src/App.tsx and confirmed live HMR updated the preview iframe.");
      evidence.notes.push("Confirmed LSP status cleared after node_modules installed.");
    }

    const finalLayout = await evidence.snapshotLayout(page);
    evidence.writeJson("layout.json", finalLayout);
  },
};
