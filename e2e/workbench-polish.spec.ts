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
  await expect(page.getByTestId("wb-unsaved-dialog")).toBeVisible();
  await page.getByTestId("wb-unsaved-cancel").click();
  await expect(page.getByTestId("wb-unsaved-dialog")).toHaveCount(0);
  await expect(page.locator('[data-testid="editor-tab"][data-path="beta.ts"]')).toBeVisible();

  // Save & Close persists the edit and closes the tab.
  await page.getByRole("button", { name: "Close beta.ts" }).click();
  await page.getByTestId("wb-unsaved-save").click();
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

  const chain = page.locator('[data-wb-tree-row][data-path="src/app/ui"]');
  await expect(chain).toBeVisible();
  await expect(chain.locator('[data-wb-drop-segment="src"]')).toHaveText("src");
  await expect(chain.locator('[data-wb-drop-segment="src/app"]')).toHaveText("app");
  await expect(chain.locator('[data-wb-drop-segment="src/app/ui"]')).toHaveText("ui");

  const buttonRow = page.locator('[data-wb-tree-row][data-path="src/app/ui/Button.tsx"]');
  await expect(buttonRow).toBeVisible();
  await expect(buttonRow.locator(".wb-tree-guide")).toHaveCount(1);

  // Focus tree and trigger inline filter with Mod+F.
  await buttonRow.focus();
  await pressMod(page, "Mod+f");
  const filterInput = page.locator("[data-wb-filter-field] input");
  await expect(filterInput).toBeVisible();
  await filterInput.fill("Button");
  await expect(buttonRow).toBeVisible();
  await expect(page.locator('[data-wb-tree-row][data-path="README.md"]')).toHaveCount(0);

  // Select All in a filtered tree selects matching files, never context-only ancestor folders.
  // Even with a context-only folder focused, Select All + Delete targets only the matching file.
  const srcRow = page.locator('[data-wb-tree-row][data-path="src"]');
  await srcRow.focus();
  await pressMod(page, "Mod+a");
  await expect(srcRow).toHaveAttribute("data-selected", "false");
  await expect(buttonRow).toHaveAttribute("data-selected", "true");
  await page.keyboard.press("Delete");
  const confirmDialog = page.getByTestId("wb-confirm-dialog");
  await expect(confirmDialog).toBeVisible();
  await expect(confirmDialog).toContainText("Button.tsx");
  await expect(confirmDialog).not.toContainText("Delete src");
  await page.keyboard.press("Escape");
  await expect(confirmDialog).toHaveCount(0);

  // Starting rename (F2) while filtered clears the filter and reveals the inline name box,
  // even when a grandparent folder was collapsed prior to filtering.
  await filterInput.press("Escape");
  await expect(filterInput).toHaveValue("");
  await chain.click(); // collapses `src` while leaving `src/app` expanded inside
  await expect(buttonRow).toHaveCount(0);
  await pressMod(page, "Mod+f");
  await page.locator("[data-wb-filter-field] input").fill("Button");
  await expect(buttonRow).toBeVisible();
  await buttonRow.focus();
  await page.keyboard.press("F2");
  await expect(page.getByTestId("wb-tree-inline-input")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-wb-tree-row][data-path="README.md"]')).toBeVisible();
});

test("terminal capture-phase context menu opens with Clear and Split actions", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await newWorkspace(page);
  await expect(page.getByTestId("terminal-state")).toHaveText("ready");

  await page.locator(".wb-terminal-view .wb-terminal-canvas-host").first().click({ button: "right" });
  await expect(page.locator("[data-wb-point-context-menu]")).toBeVisible();
  await expect(page.getByTestId("wb-term-ctx-clear")).toBeVisible();
  await expect(page.getByTestId("term-menu-split")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-wb-point-context-menu]")).toHaveCount(0);
});

const terminalCanvasBackground = (page: Page) =>
  page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(".wb-terminal-canvas-host canvas");
    return canvas?.parentElement ? getComputedStyle(canvas.parentElement).backgroundColor : "";
  });

const terminalRootInlineBackground = (page: Page) =>
  page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(".wb-terminal-canvas-host canvas");
    return canvas?.parentElement?.style.backgroundColor ?? "";
  });

const editorHasFocus = (page: Page) =>
  page.evaluate(() => {
    const active = document.activeElement;
    return active instanceof HTMLElement && active.closest('[data-testid="editor"]') !== null;
  });

test("terminal updates its theme live across light and dark toggles, even when hidden or mid-boot", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 390, height: 844 });

  // Hold shell-engine.wasm so startTerminal pauses AFTER capturing the initial light theme and
  // mounting the Ghostty canvas, but BEFORE handle.current is attached (mid-boot resync window).
  let releaseShell!: () => void;
  const shellPaused = new Promise<void>((resolve) => {
    releaseShell = resolve;
  });
  await page.route("**/shell-engine.wasm", async (route) => {
    await shellPaused;
    await route.continue();
  });

  await page.goto("/");
  await page.getByTestId("template-blank").click();
  await expect(page).toHaveURL(/\/w\/[a-z0-9]+$/);
  await expect(page.getByTestId("phone-menu")).toBeVisible();

  // Wait until Ghostty mounted with its initial light background while the shell is still held.
  await expect
    .poll(() => terminalRootInlineBackground(page))
    .toMatch(/rgb\(255,\s*255,\s*255\)|rgb\(255 255 255/);
  await expect(page.getByTestId("terminal-state")).not.toHaveText("ready");

  // Mid-boot toggle: switch to dark while startTerminal is paused (handle.current is undefined).
  await page.getByTestId("phone-menu").click();
  await page.getByRole("button", { name: "Use dark theme" }).click();
  await page.locator(".wb-scrim").click();

  // Release startup and verify the post-boot resync turns the hidden terminal dark before reveal.
  releaseShell();
  await expect(page.getByTestId("terminal-state")).toHaveText("ready");
  await expect.poll(() => terminalRootInlineBackground(page)).toMatch(/rgb\(10,\s*13,\s*20\)|rgb\(10 13 20/);

  // Toggle dark -> light -> dark while still hidden, checking the hidden terminal before reveal.
  await page.getByTestId("phone-menu").click();
  await page.getByRole("button", { name: "Use light theme" }).click();
  await expect
    .poll(() => terminalRootInlineBackground(page))
    .toMatch(/rgb\(255,\s*255,\s*255\)|rgb\(255 255 255/);
  await page.getByRole("button", { name: "Use dark theme" }).click();
  await expect.poll(() => terminalRootInlineBackground(page)).toMatch(/rgb\(10,\s*13,\s*20\)|rgb\(10 13 20/);
  await page.locator(".wb-scrim").click();

  await page.getByTestId("pane-switcher").getByRole("button", { name: "Terminal" }).click();
  await expect.poll(() => terminalCanvasBackground(page)).toBe("rgb(10, 13, 20)");

  // Toggle live while the terminal is on screen: dark -> light -> dark.
  await page.getByTestId("phone-menu").click();
  await page.getByRole("button", { name: "Use light theme" }).click();
  await expect.poll(() => terminalCanvasBackground(page)).toBe("rgb(255, 255, 255)");
  await page.getByRole("button", { name: "Use dark theme" }).click();
  await expect.poll(() => terminalCanvasBackground(page)).toBe("rgb(10, 13, 20)");
});

function dispatchCancelledMouseDrag(): void {
  window.dispatchEvent(new PointerEvent("pointermove", { pointerType: "mouse", pointerId: 1, clientX: 40 }));
  window.dispatchEvent(
    new PointerEvent("pointercancel", { pointerType: "mouse", pointerId: 1, clientX: 40 }),
  );
}

test.describe("mobile and hybrid touch tab activation", () => {
  test.use({ hasTouch: true });

  test("switching file tabs on mobile never focuses the editor, while desktop keyboard activation still does", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await newWorkspace(page);
    await writeFile(page, "alpha.ts", "export const alpha = 1;\n");
    await writeFile(page, "beta.ts", "export const beta = 2;\n");

    await page.getByTestId("file-tree").getByRole("treeitem", { name: "alpha.ts", exact: true }).tap();
    await expect.poll(() => editorText(page)).toBe("export const alpha = 1;\n");
    await expect.poll(() => editorHasFocus(page)).toBe(false);

    await page.getByTestId("pane-switcher").getByRole("button", { name: "Files" }).tap();
    await page.getByTestId("file-tree").getByRole("treeitem", { name: "beta.ts", exact: true }).tap();
    await expect.poll(() => editorText(page)).toBe("export const beta = 2;\n");
    await expect.poll(() => editorHasFocus(page)).toBe(false);

    // Switching tabs on mobile must not focus the editor or trigger the soft keyboard.
    await page.locator('[data-testid="editor-tab"][data-path="alpha.ts"]').tap();
    await expect.poll(() => editorText(page)).toBe("export const alpha = 1;\n");
    expect(await editorHasFocus(page)).toBe(false);

    // An explicit tap directly on the editor text surface focuses the editor for real editing.
    await page.getByTestId("editor").tap();
    await expect.poll(() => editorHasFocus(page)).toBe(true);

    // Tapping another file tab afterwards leaves the editor unfocused again.
    await page.locator('[data-testid="editor-tab"][data-path="beta.ts"]').tap();
    await expect.poll(() => editorText(page)).toBe("export const beta = 2;\n");
    await expect.poll(() => editorHasFocus(page)).toBe(false);

    // Hybrid desktop check: a cancelled mouse drag + Enter must still focus on Enter AND must not
    // swallow the next real touch tap on another tab (which opens it with the editor unfocused).
    await page.setViewportSize({ width: 1440, height: 900 });
    const alphaTab = page.locator('[data-testid="editor-tab"][data-path="alpha.ts"]');
    const betaTab = page.locator('[data-testid="editor-tab"][data-path="beta.ts"]');
    await betaTab.dispatchEvent("pointerdown", {
      pointerType: "mouse",
      pointerId: 1,
      button: 0,
      clientX: 20,
    });
    await page.evaluate(dispatchCancelledMouseDrag);
    await alphaTab.focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => editorText(page)).toBe("export const alpha = 1;\n");
    await expect.poll(() => editorHasFocus(page)).toBe(true);

    await betaTab.tap();
    await expect.poll(() => editorText(page)).toBe("export const beta = 2;\n");
    await expect.poll(() => editorHasFocus(page)).toBe(false);
  });
});
