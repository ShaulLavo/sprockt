import type { Page } from "@playwright/test";
import {
  editorText,
  expect,
  newWorkspace,
  openFile,
  runInTerminal,
  test,
  typeInEditor,
  withoutAutosave,
  writeFile,
} from "./helpers";

async function pressMod(page: Page, shortcut: string): Promise<void> {
  const mac = await page.evaluate(() => /mac/i.test(`${navigator.platform} ${navigator.userAgent}`));
  await page.keyboard.press(shortcut.replace("Mod+", mac ? "Meta+" : "Control+"));
}

test("workbench hotkeys toggle panes and Mod+Shift+P opens command mode", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await newWorkspace(page);
  await expect(page.getByTestId("terminal-state")).toHaveText("ready");

  await pressMod(page, "Mod+b");
  await expect(page.getByTestId("workbench")).toHaveAttribute("data-explorer", "closed");
  await pressMod(page, "Mod+b");
  await expect(page.getByTestId("workbench")).toHaveAttribute("data-explorer", "open");

  await pressMod(page, "Mod+j");
  await expect(page.getByTestId("workbench")).toHaveAttribute("data-terminal", "closed");
  await pressMod(page, "Mod+j");
  await expect(page.getByTestId("workbench")).toHaveAttribute("data-terminal", "open");

  await pressMod(page, "Mod+Shift+p");
  await expect(page.getByTestId("quick-open")).toBeVisible();
  await expect(page.getByTestId("quick-open").locator("input")).toHaveValue(">");
  await expect(page.getByTestId("quick-open-command").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("quick-open")).toHaveCount(0);
});

test("closing a dirty tab opens the Sheet & Biro save dialog and tab context menu closes others", async ({
  page,
}) => {
  await withoutAutosave(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await newWorkspace(page);
  await writeFile(page, "alpha.ts", "export const a = 1;\n");
  await writeFile(page, "beta.ts", "export const b = 2;\n");

  await openFile(page, "alpha.ts");
  await expect.poll(() => editorText(page)).toBe("export const a = 1;\n");
  await openFile(page, "beta.ts");
  await expect.poll(() => editorText(page)).toBe("export const b = 2;\n");

  await typeInEditor(page, "// edited");
  await expect(page.locator('[data-testid="editor-tab"][data-path="beta.ts"]')).toHaveClass(/is-dirty/);

  // Close dirty tab -> custom dialog appears; Cancel keeps tab open.
  await page.getByRole("button", { name: "Close beta.ts" }).click();
  await expect(page.getByTestId("unsaved-dialog")).toBeVisible();
  await page.getByTestId("unsaved-cancel").click();
  await expect(page.getByTestId("unsaved-dialog")).toHaveCount(0);
  await expect(page.locator('[data-testid="editor-tab"][data-path="beta.ts"]')).toBeVisible();

  // Save & Close persists the edit and closes the tab.
  await page.getByRole("button", { name: "Close beta.ts" }).click();
  await page.getByTestId("unsaved-save").click();
  await expect(page.locator('[data-testid="editor-tab"][data-path="beta.ts"]')).toHaveCount(0);
  const disk = await page.evaluate(() => globalThis.sprockt?.workspace?.files.read("beta.ts"));
  expect(disk).toBe("export const b = 2;\n// edited");

  // Reopen beta.ts and use the tab context menu to close others.
  await openFile(page, "beta.ts");
  await expect(page.getByTestId("editor-tab")).toHaveCount(2);
  await page.locator('[data-testid="editor-tab"][data-path="beta.ts"]').click({ button: "right" });
  await page.getByTestId("tab-menu-close-others").click();
  await expect(page.getByTestId("editor-tab")).toHaveCount(1);
  await expect(page.locator('[data-testid="editor-tab"][data-path="beta.ts"]')).toBeVisible();
});

test("explorer compacts single-child folders, shows indent guides, and supports inline filter", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await newWorkspace(page);
  await runInTerminal(page, "mkdir -p src/app/ui && echo 'export const x = 1;' > src/app/ui/Button.tsx");
  await writeFile(page, "README.md", "# hi\n");

  const chain = page.locator('[data-testid="tree-row"][data-path="src/app/ui"]');
  await expect(chain).toBeVisible();
  await expect(chain.locator('[data-segment-path="src"]')).toHaveText("src");
  await expect(chain.locator('[data-segment-path="src/app"]')).toHaveText("app");
  await expect(chain.locator('[data-segment-path="src/app/ui"]')).toHaveText("ui");

  const buttonRow = page.locator('[data-testid="tree-row"][data-path="src/app/ui/Button.tsx"]');
  await expect(buttonRow).toBeVisible();
  await expect(buttonRow.locator(".row-guide")).toHaveCount(1);

  // Focus tree and trigger inline filter with Mod+F.
  await buttonRow.focus();
  await pressMod(page, "Mod+f");
  const filterInput = page.getByTestId("tree-filter-input");
  await expect(filterInput).toBeVisible();
  await filterInput.fill("Button");
  await expect(buttonRow).toBeVisible();
  await expect(page.locator('[data-testid="tree-row"][data-path="README.md"]')).toHaveCount(0);

  // Select All in a filtered tree selects matching files, never context-only ancestor folders.
  await buttonRow.focus();
  await pressMod(page, "Mod+a");
  await expect(page.locator('[data-testid="tree-row"][data-path="src"]')).not.toHaveClass(/is-selected/);
  await expect(buttonRow).toHaveClass(/is-selected/);

  // Starting rename (F2) while filtered clears the filter and reveals the inline name box.
  await page.keyboard.press("F2");
  await expect(page.getByTestId("tree-filter")).toHaveCount(0);
  await expect(page.getByTestId("tree-input")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-testid="tree-row"][data-path="README.md"]')).toBeVisible();
});

test("terminal capture-phase context menu opens with Clear and Split actions", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await newWorkspace(page);
  await expect(page.getByTestId("terminal-state")).toHaveText("ready");

  await page.locator(".term-view .term-canvas").first().click({ button: "right" });
  await expect(page.getByTestId("tree-menu")).toBeVisible();
  await expect(page.getByTestId("term-menu-clear")).toBeVisible();
  await expect(page.getByTestId("term-menu-split")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("tree-menu")).toHaveCount(0);
});
