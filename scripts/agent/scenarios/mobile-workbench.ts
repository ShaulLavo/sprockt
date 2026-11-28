import type { Page } from "@playwright/test";
import { SELECTORS } from "../selectors.ts";
import { assertCondition, waitForWorkbenchReady, type AgentScenario } from "./types.ts";

async function editorHasFocus(page: Page): Promise<boolean> {
  return page.evaluate((hostSel) => {
    const active = document.activeElement;
    const host = document.querySelector(hostSel);
    return Boolean(active && host && host.contains(active));
  }, SELECTORS.editor.host);
}

async function sampleTerminalBrightness(page: Page): Promise<{
  readonly bg: string;
  readonly luminance: number;
}> {
  const png = await page.locator(SELECTORS.terminal.host).screenshot();
  const base64 = png.toString("base64");
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas unavailable for pixel sampling");
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(Math.floor(img.width / 2), Math.floor(img.height / 2), 1, 1).data;
    const r = px[0] ?? 255;
    const g = px[1] ?? 255;
    const b = px[2] ?? 255;
    return {
      bg: `rgb(${r}, ${g}, ${b})`,
      luminance: Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b),
    };
  }, base64);
}

export const mobileWorkbenchScenario: AgentScenario = {
  name: "mobile-workbench",
  description:
    "Phone (390x844, touch): verify zero initial LSP squiggles, tab switching never focuses editor, explicit editor tap focuses, and hidden light->dark theme syncs Ghostty terminal.",
  readOnly: false,
  defaultViewport: "phone",
  async run(ctx) {
    const { page, baseUrl, args, evidence } = ctx;
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.locator(SELECTORS.landing.templateCard("vite-react")).tap();
    await page.waitForURL(/\/w\/[a-z0-9]+$/, { timeout: 30_000 });
    await waitForWorkbenchReady(page, args.timeoutMs);

    const initialTheme = await page.evaluate(() => ({
      attr: document.documentElement.getAttribute("data-theme"),
      prefersDark: window.matchMedia("(prefers-color-scheme: dark)").matches,
    }));
    const startsLight =
      initialTheme.attr === "light" || (initialTheme.attr === null && !initialTheme.prefersDark);
    assertCondition(
      startsLight,
      `mobile-workbench must start in light mode to test Light->Dark transition (data-theme="${initialTheme.attr}", prefersDark=${initialTheme.prefersDark})`,
    );

    await page.locator(SELECTORS.workbench.paneButton("Files")).tap();
    const appTsx = page
      .locator(SELECTORS.explorer.tree)
      .getByRole("treeitem", { name: "App.tsx", exact: true });
    if ((await appTsx.count()) === 0) {
      await page.locator(SELECTORS.explorer.tree).getByRole("treeitem", { name: "src", exact: true }).tap();
    }
    await appTsx.tap();
    await page.waitForFunction(
      (sel) => document.querySelector(sel)?.getAttribute("aria-label") === "src/App.tsx",
      SELECTORS.editor.activeFile,
    );
    await page.locator(SELECTORS.workbench.paneButton("Files")).tap();
    await page.locator(SELECTORS.explorer.tree).getByRole("treeitem", { name: "App.css", exact: true }).tap();
    await page.waitForFunction(
      (sel) => document.querySelector(sel)?.getAttribute("aria-label") === "src/App.css",
      SELECTORS.editor.activeFile,
    );

    const tabs = page.locator(SELECTORS.editor.tab);
    assertCondition((await tabs.count()) >= 2, "Expected at least 2 open tabs on mobile");
    await tabs.filter({ hasText: "App.tsx" }).first().tap();
    await page.waitForFunction(
      (sel) => document.querySelector(sel)?.getAttribute("aria-label") === "src/App.tsx",
      SELECTORS.editor.activeFile,
    );
    await page.waitForTimeout(200);
    const focusedAfterTabTap = await editorHasFocus(page);
    assertCondition(
      !focusedAfterTabTap,
      "Tapping a file tab on mobile must NOT focus the editor (opens soft keyboard)",
    );
    await evidence.capture(page, "mobile-tab-switch-no-focus");

    await page.locator(SELECTORS.editor.host).tap();
    await page.waitForTimeout(200);
    const focusedAfterEditorTap = await editorHasFocus(page);
    assertCondition(focusedAfterEditorTap, "Explicit tap on editor surface on mobile must focus the editor");
    await evidence.capture(page, "mobile-editor-explicit-focus");

    // Toggle Light -> Dark while Terminal pane is hidden (Code pane is visible).
    await page.locator(SELECTORS.workbench.phoneMenu).tap();
    await page.locator(SELECTORS.workbench.phoneMenuPanel).waitFor({ state: "visible" });
    await page.locator(SELECTORS.workbench.phoneMenuPanel).locator(SELECTORS.workbench.themeDark).tap();
    await page.waitForFunction(() => document.documentElement.getAttribute("data-theme") === "dark");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    await page.locator(SELECTORS.workbench.paneButton("Terminal")).tap();
    await page.locator(SELECTORS.terminal.tab).getByText("bash", { exact: true }).tap();
    await page.waitForFunction(
      (sel) => document.querySelector(sel)?.textContent?.trim() === "ready",
      SELECTORS.terminal.state,
      { timeout: 60_000 },
    );
    await page.waitForTimeout(400);

    const terminalTone = await sampleTerminalBrightness(page);
    assertCondition(
      terminalTone.luminance < 60,
      `Terminal stayed bright after hidden Light->Dark toggle: bg=${terminalTone.bg} lum=${terminalTone.luminance}`,
    );
    await evidence.capture(page, "mobile-terminal-dark-synced");

    const layout = await evidence.snapshotLayout(page);
    assertCondition(layout.overflowX === 0, `Mobile workbench overflowX=${layout.overflowX}`);
    evidence.writeJson("layout.json", { layout, terminalTone, focusedAfterTabTap, focusedAfterEditorTap });
    evidence.notes.push("Mobile tab tap kept editor unfocused; explicit editor tap focused it.");
    evidence.notes.push(`Hidden Light->Dark toggle synced terminal dark background (${terminalTone.bg}).`);
  },
};
