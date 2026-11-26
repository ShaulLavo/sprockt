import { SELECTORS } from "../selectors.ts";
import { assertCondition, waitForWorkbenchReady, type AgentScenario } from "./types.ts";

export const workbenchTabsAndExplorerScenario: AgentScenario = {
  name: "workbench-tabs-and-explorer",
  description:
    "Verify explorer tree filtering, creating a new file, switching editor tabs, and opening the command palette.",
  readOnly: false,
  defaultViewport: "desktop",
  async run(ctx) {
    const { page, baseUrl, args, evidence } = ctx;
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.locator(SELECTORS.landing.templateCard("vite-react")).click();
    await page.waitForURL(/\/w\/[a-z0-9]+$/, { timeout: 30_000 });
    await waitForWorkbenchReady(page, args.timeoutMs);

    await page.locator(SELECTORS.explorer.tree).getByRole("button", { name: "App.tsx", exact: true }).click();
    await page.waitForFunction(
      (sel) => document.querySelector(sel)?.getAttribute("aria-label") === "src/App.tsx",
      SELECTORS.editor.activeFile,
    );
    await page.locator(SELECTORS.explorer.tree).getByRole("button", { name: "App.tsx", exact: true }).focus();
    await page.keyboard.press("ControlOrMeta+f");
    await page.locator(SELECTORS.explorer.filterInput).fill("App.css");
    await page.waitForFunction(() => {
      const tree = document.querySelector('[data-testid="file-tree"]');
      const text = tree?.textContent ?? "";
      return text.includes("App.css") && !text.includes("package.json");
    });
    await page.locator(SELECTORS.explorer.tree).getByRole("button", { name: "App.css", exact: true }).click();
    await page.waitForFunction(
      (sel) => document.querySelector(sel)?.getAttribute("aria-label") === "src/App.css",
      SELECTORS.editor.activeFile,
    );
    await evidence.capture(page, "filtered-and-opened-tab");

    await page.locator(SELECTORS.explorer.filterInput).focus();
    await page.keyboard.press("Escape");
    await page.locator(SELECTORS.explorer.newFile).click();
    await page.locator(SELECTORS.explorer.input).fill("notes.txt");
    await page.locator(SELECTORS.explorer.input).press("Enter");
    await page.waitForFunction(
      (sel) => document.querySelector(sel)?.getAttribute("aria-label")?.endsWith("notes.txt") ?? false,
      SELECTORS.editor.activeFile,
    );
    const createdPath = await page.locator(SELECTORS.editor.activeFile).getAttribute("aria-label");
    assertCondition(Boolean(createdPath), "Expected newly created file path in editor breadcrumb");
    await page.locator(SELECTORS.editor.root).click();
    const expectedText = "verified via agent:browser";
    await page.keyboard.type(expectedText);
    await page.waitForFunction(
      async ({ path, text }) => {
        const content = await globalThis.sprockt?.workspace?.files.read(path);
        return content === text;
      },
      { path: createdPath ?? "notes.txt", text: expectedText },
      { timeout: 10_000 },
    );
    await evidence.capture(page, "created-and-typed-file");

    const tabCount = await page.locator(SELECTORS.editor.tab).count();
    assertCondition(tabCount >= 2, `Expected at least 2 open editor tabs, got ${tabCount}`);

    await page.locator(SELECTORS.workbench.commandPaletteButton).click();
    await page.locator(SELECTORS.workbench.commandPaletteInput).waitFor({ state: "visible", timeout: 5_000 });
    await page.waitForTimeout(150);
    await evidence.capture(page, "command-palette-open");
    await page.keyboard.press("Escape");

    const layout = await evidence.snapshotLayout(page);
    assertCondition(layout.overflowX === 0, `Workbench desktop overflowX=${layout.overflowX}`);
    evidence.writeJson("layout.json", layout);
    evidence.notes.push(
      `Explorer filter, new file creation, ${tabCount} tabs, and command palette verified.`,
    );
  },
};
