import type { Page } from "@playwright/test";
import { SELECTORS } from "../selectors.ts";
import { assertCondition, waitForWorkbenchReady, type AgentScenario } from "./types.ts";

const STARTER_EXPECTATIONS: Readonly<
  Record<string, { readonly heading: string; readonly entryFile?: string }>
> = {
  "vite-react": { heading: "Hello from bun.wasm", entryFile: "App.tsx" },
  vanilla: { heading: "Hello from vanilla TypeScript", entryFile: "main.ts" },
  sveltekit: { heading: "Hello from sveltekit", entryFile: "+page.svelte" },
  hono: { heading: "Hello from hono", entryFile: "server.ts" },
  "bun-sqlite": { heading: "Bun.serve + bun:sqlite", entryFile: "server.ts" },
  astro: { heading: "Hello from astro", entryFile: "index.astro" },
  "next-app": { heading: "Next.js App Router", entryFile: "page.tsx" },
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
  description:
    "Open a starter (default vite-react), check CSS.highlights LSP cleanliness & dep gate, start dev server, verify rendered preview + counter + real editor HMR.",
  readOnly: false,
  defaultViewport: "desktop",
  async run(ctx) {
    const { page, baseUrl, args, evidence } = ctx;
    const starterId = args.starter;
    const spec = STARTER_EXPECTATIONS[starterId];
    assertCondition(
      spec !== undefined,
      `Unknown starter "${starterId}". Supported: ${Object.keys(STARTER_EXPECTATIONS).join(", ")}`,
    );

    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.waitForSelector(SELECTORS.landing.templateCard(starterId));
    await page.locator(SELECTORS.landing.templateCard(starterId)).click();
    await page.waitForURL(/\/w\/[a-z0-9]+$/, { timeout: 30_000 });
    await waitForWorkbenchReady(page, args.timeoutMs);
    await page.waitForSelector(SELECTORS.editor.root, { timeout: 30_000 });

    if (spec.entryFile) {
      await page
        .locator(SELECTORS.explorer.tree)
        .getByRole("button", { name: spec.entryFile, exact: true })
        .click();
      await page.waitForFunction(
        ({ sel, name }) => document.querySelector(sel)?.getAttribute("aria-label")?.endsWith(name) ?? false,
        { sel: SELECTORS.editor.activeFile, name: spec.entryFile },
      );
    }
    await page.waitForTimeout(1500);

    const initialErrors = await readLspErrorRanges(page);
    const initialStatus = (await page.locator(SELECTORS.workbench.statusBar).innerText()).trim();
    assertCondition(
      initialErrors.length === 0,
      `Expected 0 CSS.highlights lsp-plugin-error ranges before install, found ${initialErrors.length}: ${initialErrors.join(", ")}`,
    );
    if (starterId === "vite-react") {
      assertCondition(
        initialStatus.includes("Install deps for TS"),
        `Expected "Install deps for TS" dependency gate in status bar before install, got "${initialStatus}"`,
      );
    }
    await evidence.capture(page, "starter-opened-clean-lsp");
    evidence.notes.push(
      `Opened starter "${starterId}": 0 CSS.highlights LSP errors (status: "${initialStatus.replace(/\s+/g, " ")}").`,
    );

    const startBtn = page.locator(SELECTORS.preview.startButton).first();
    await startBtn.waitFor({ state: "visible", timeout: 30_000 });
    await startBtn.click();

    await waitForPreviewContent(page, spec.heading, args.timeoutMs);
    await evidence.capture(page, "dev-server-rendered");

    if (starterId === "vite-react") {
      const frame = page.frameLocator(SELECTORS.preview.frame);
      await frame.getByRole("button", { name: /count is 0/i }).click();
      await frame.getByRole("button", { name: /count is 1/i }).waitFor({ timeout: 10_000 });
      evidence.notes.push("Preview interactive counter incremented from 0 to 1.");

      await editAppHeadingInEditor(page);
      await waitForPreviewContent(page, "Hello from bun.wasm live", 30_000);
      await frame.getByRole("button", { name: "count is 1", exact: true }).waitFor({ timeout: 5_000 });
      await page.waitForTimeout(1000);
      const postInstallStatus = (await page.locator(SELECTORS.workbench.statusBar).innerText()).trim();
      const postInstallErrors = await readLspErrorRanges(page);
      assertCondition(
        !postInstallStatus.includes("Install deps for TS"),
        `Expected "Install deps for TS" to clear after bun install, got "${postInstallStatus}"`,
      );
      assertCondition(
        postInstallErrors.length === 0,
        `Expected 0 LSP errors after install, found: ${postInstallErrors.join(", ")}`,
      );
      await evidence.capture(page, "hmr-updated");
      evidence.notes.push("Typed edit in editor triggered live HMR while preserving count is 1.");
      evidence.notes.push("LSP dependency gate cleared with 0 CSS.highlights errors after install.");
    }

    const finalLayout = await evidence.snapshotLayout(page);
    evidence.writeJson("layout.json", finalLayout);
  },
};
