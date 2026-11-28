import type { Page } from "@playwright/test";
import { startBootTiming } from "../boot-timing.ts";
import { SELECTORS } from "../selectors.ts";
import { assertCondition, waitForWorkbenchReady, type AgentScenario } from "./types.ts";

const STARTER_EXPECTATIONS: Readonly<Record<string, { readonly heading: string }>> = {
  "vite-react": { heading: "Hello from bun.wasm" },
  vanilla: { heading: "Hello from vanilla TypeScript" },
  sveltekit: { heading: "Hello from sveltekit" },
  hono: { heading: "Hello from hono" },
  "bun-sqlite": { heading: "Bun.serve + bun:sqlite" },
  astro: { heading: "Hello from astro" },
  "next-app": { heading: "Next.js App Router" },
};

/** Reads real `lsp-plugin-error` highlight ranges painted by Singapore via `CSS.highlights`. */
async function readLspErrorRanges(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const texts: string[] = [];
    for (const [name, highlight] of CSS.highlights) {
      if (!name.includes("lsp-plugin-error")) continue;
      for (const range of highlight) texts.push(range.toString());
    }
    return texts;
  });
}

async function waitForPreviewContent(page: Page, expectedText: string, timeout: number): Promise<void> {
  const body = page.frameLocator(SELECTORS.preview.frame).locator("body");
  try {
    await body.getByText(expectedText, { exact: true }).first().waitFor({ timeout });
  } catch (error) {
    const output = await page.locator(SELECTORS.preview.taskOutput).allTextContents();
    throw new Error(
      `Preview did not render "${expectedText}". Last dev output: ${output.join("").slice(-600)}`,
      { cause: error },
    );
  }
}

async function editAppHeadingInEditor(page: Page): Promise<void> {
  await page.locator(SELECTORS.editor.root).click();
  const isMac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform));
  await page.keyboard.press(isMac ? "Meta+ArrowUp" : "Control+Home");
  // Line 9 of vite-react src/App.tsx is `      <h1>Hello from bun.wasm</h1>`.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.type(" live");
}

export const starterDevServerScenario: AgentScenario = {
  name: "starter-dev-server",
  description: "Verify starter auto-start, preview reload, React HMR and cold-boot timings.",
  readOnly: false,
  live: true,
  defaultViewport: "desktop",
  async run(ctx) {
    const { page, baseUrl, args, evidence } = ctx;
    const spec = STARTER_EXPECTATIONS[args.starter];
    assertCondition(
      spec !== undefined,
      `Unknown starter "${args.starter}". Supported: ${Object.keys(STARTER_EXPECTATIONS).join(", ")}`,
    );

    await page.goto(baseUrl);
    const card = page.locator(SELECTORS.landing.templateCard(args.starter));
    await card.waitFor({ timeout: args.timeoutMs });
    const timing = startBootTiming();
    await (args.viewport.hasTouch ? card.tap() : card.click());
    await page.waitForURL(/\/w\/[a-z0-9]+$/, { timeout: args.timeoutMs });
    timing.mark("workspaceOpenedMs");
    await waitForWorkbenchReady(page, args.timeoutMs);
    timing.mark("workbenchReadyMs");

    await page.locator(`${SELECTORS.preview.task}[data-status="running"]`).waitFor({
      state: "attached",
      timeout: args.timeoutMs,
    });
    await page.locator(SELECTORS.preview.port).waitFor({ state: "attached", timeout: args.timeoutMs });
    timing.mark("serverListeningMs");
    if (args.viewport.hasTouch) await page.locator(SELECTORS.workbench.paneButton("Preview")).tap();

    await waitForPreviewContent(page, spec.heading, args.timeoutMs);
    timing.mark("previewRenderedMs");
    const report = await timing.report(page);
    evidence.writeJson("cold-boot.json", report);
    evidence.notes.push(
      `Cold boot in ms from starter activation: ${JSON.stringify(report.milestonesSinceActivation)}`,
    );
    await evidence.capture(page, "auto-started-preview");

    if (args.starter === "vite-react") {
      await verifyReactPreview(page, args.timeoutMs);
      evidence.notes.push("Preview reload reset the React counter and the server continued running.");
      if (!args.viewport.hasTouch) {
        await verifyReactHmr(page, args.timeoutMs);
        await evidence.capture(page, "hmr-updated");
        evidence.notes.push("An editor change triggered HMR without resetting the counter.");
      }
    }

    evidence.writeJson("layout.json", await evidence.snapshotLayout(page));
  },
};

async function verifyReactPreview(page: Page, timeout: number): Promise<void> {
  const frame = page.frameLocator(SELECTORS.preview.frame);
  const zero = frame.getByRole("button", { name: "count is 0", exact: true });
  await zero.click({ timeout });
  await frame.getByRole("button", { name: "count is 1", exact: true }).waitFor({ timeout });
  await page.locator(SELECTORS.preview.reload).click({ timeout });
  await zero.waitFor({ timeout });
}

async function verifyReactHmr(page: Page, timeout: number): Promise<void> {
  const frame = page.frameLocator(SELECTORS.preview.frame);
  await frame.getByRole("button", { name: "count is 0", exact: true }).click({ timeout });
  await page.locator(SELECTORS.explorer.tree).getByRole("treeitem", { name: "App.tsx", exact: true }).click({
    timeout,
  });
  await editAppHeadingInEditor(page);
  await waitForPreviewContent(page, "Hello from bun.wasm live", timeout);
  await frame.getByRole("button", { name: "count is 1", exact: true }).waitFor({ timeout });
  const errors = await readLspErrorRanges(page);
  assertCondition(errors.length === 0, `Unexpected TypeScript diagnostics: ${errors.join(", ")}`);
}
