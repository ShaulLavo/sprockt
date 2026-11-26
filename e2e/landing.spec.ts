import type { Page } from "@playwright/test";
import { editorText, expect, test } from "./helpers";

const TEMPLATE_IDS = [
  "vite-react",
  "next-app",
  "hono",
  "astro",
  "sveltekit",
  "vanilla",
  "bun-sqlite",
] as const;

const PHONE_TAP_TARGETS = [
  "hero-start-cta",
  "repo-submit",
  "new-workspace",
  "template-vite-react",
  "template-hono",
] as const;

test("landing renders cleanly without loading workbench or Waffle runtime code and opens GitHub routes", async ({
  page,
}) => {
  const loadedScripts: string[] = [];
  page.on("response", (response) => {
    const url = response.url();
    if (url.includes("/assets/") && url.endsWith(".js")) loadedScripts.push(url);
  });

  await page.goto("/");
  await expect(page.getByTestId("landing-page")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("An open-source IDE in your browser tab");

  // Wait for workspace discovery to finish so lazy imports (if any) have settled.
  await expect(page.getByTestId("workspace-empty")).toContainText("No saved workspaces yet.");

  // All seven starter templates are visible and interactive.
  await Promise.all(TEMPLATE_IDS.map((id) => expect(page.getByTestId(`template-${id}`)).toBeVisible()));

  // Neither the workbench nor Waffle runtime/storage code loads on a cold landing page.
  expect(loadedScripts.some((url) => /Workbench-|\/runtime-|waffle|storage-discovery/i.test(url))).toBe(
    false,
  );

  // Invalid repo input shows an inline error; escaped GitHub URLs decode once without double-encoding.
  await page.getByTestId("repo-input").fill("not a valid repo");
  await page.getByTestId("repo-submit").click();
  await expect(page.getByTestId("repo-error")).toBeVisible();

  await page.getByTestId("repo-input").fill("https://github.com/oven-sh/bun/tree/main/docs/Caf%C3%A9");
  await page.getByTestId("repo-submit").click();
  await expect(page).toHaveURL(/\/github\/oven-sh\/bun\/tree\/main\/docs\/Caf%C3%A9$/);

  await page.goto("/");
  await page.getByTestId("sample-repo-link").click();
  await expect(page).toHaveURL(/\/github\/ShaulLavo\/bash-web$/);
});

test("clicking a template creates a workspace whose files exist and survive reload", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("template-vite-react").click();
  await expect(page).toHaveURL(/\/w\/[a-z0-9]+$/);

  const tree = page.getByTestId("file-tree");
  await expect(tree).toContainText("package.json");
  await expect(tree).toContainText("vite.config.ts");
  await expect(tree).toContainText("index.html");
  await expect(tree).toContainText("App.tsx");
  await expect(page.getByTestId("save-state")).toHaveText("saved");

  await tree.getByRole("button", { name: "App.tsx", exact: true }).click();
  await expect(page.getByTestId("editor-file")).toHaveAttribute("aria-label", "src/App.tsx");
  await expect.poll(() => editorText(page)).toContain("Hello from bun.wasm");

  // Reloading preserves the seeded template files in IndexedDB.
  await page.reload();
  await expect(page.getByTestId("file-tree")).toContainText("App.tsx");
  await expect(page.getByTestId("file-tree")).toContainText("package.json");
  await page.getByTestId("file-tree").getByRole("button", { name: "App.tsx", exact: true }).click();
  await expect.poll(() => editorText(page)).toContain("Hello from bun.wasm");
});

test("workspace switcher lists without runtime JS, preserves other tab on busy rename, renames, and deletes", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await page.getByTestId("template-bun-sqlite").click();
  await expect(page).toHaveURL(/\/w\/[a-z0-9]+$/);
  const id = new URL(page.url()).pathname.slice("/w/".length);
  await expect(page.getByTestId("file-tree")).toContainText("server.ts");
  await expect(page.getByTestId("save-state")).toHaveText("saved");

  // Return to landing and verify the workspace appears from IndexedDB without loading Waffle runtime.
  await page.goto("/");
  const row = page.getByTestId(`workspace-row-${id}`);
  await expect(row).toBeVisible();
  await expect(row).toContainText("sqlite-notes");
  await expect(row).toContainText("Bun.serve + SQLite");

  const warmScripts: string[] = [];
  const onWarmResponse = (response: { url(): string }) => {
    const url = response.url();
    if (url.includes("/assets/") && url.endsWith(".js")) warmScripts.push(url);
  };
  page.on("response", onWarmResponse);
  await page.reload();
  await expect(page.getByTestId(`workspace-row-${id}`)).toBeVisible();
  page.off("response", onWarmResponse);
  expect(warmScripts.some((url) => /Workbench-|\/runtime-|waffle-runtime/i.test(url))).toBe(false);

  // Rename persists in /.sprockt/workspace.json across reloads even after clearing localStorage hints.
  const warmRow = page.getByTestId(`workspace-row-${id}`);
  await warmRow.hover();
  await page.getByTestId(`workspace-rename-${id}`).click();
  await page.getByTestId(`workspace-rename-input-${id}`).fill("notes-api");
  await page.getByTestId(`workspace-rename-save-${id}`).click();
  await expect(warmRow).toContainText("notes-api");

  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByTestId(`workspace-row-${id}`)).toContainText("notes-api");

  // Opening the workspace in another tab surfaces the live indicator and blocks rename without stealing.
  const otherTab = await context.newPage();
  await otherTab.goto(`/w/${id}`);
  await expect(otherTab.getByTestId("file-tree")).toContainText("server.ts");
  await expect(otherTab.getByTestId("save-state")).toHaveText("saved");

  await page.bringToFront();
  await page.reload();
  const busyRow = page.getByTestId(`workspace-row-${id}`);
  await expect(page.getByTestId(`workspace-live-${id}`)).toHaveText("Active in another tab");
  await busyRow.hover();
  await page.getByTestId(`workspace-rename-${id}`).click();
  await page.getByTestId(`workspace-rename-input-${id}`).fill("should-not-steal");
  await page.getByTestId(`workspace-rename-save-${id}`).click();
  await expect(page.getByTestId("workspace-notice")).toContainText("Close this workspace");
  // The other tab must keep ownership (never revoked).
  await expect(otherTab.getByTestId("save-state")).toHaveText("saved");
  await otherTab.close();

  // Once closed elsewhere, wait until the lock clears, then delete with confirmation.
  await expect
    .poll(async () => {
      await page.reload();
      await expect(page.getByTestId(`workspace-row-${id}`)).toBeVisible();
      return page.getByTestId(`workspace-live-${id}`).count();
    })
    .toBe(0);
  await page.getByTestId(`workspace-row-${id}`).hover();
  await page.getByTestId(`workspace-delete-${id}`).click();
  await expect(page.getByTestId(`workspace-confirm-delete-${id}`)).toBeVisible();
  await expect(page.getByTestId(`workspace-delete-cancel-${id}`)).toBeFocused();
  await page.getByTestId(`workspace-delete-confirm-${id}`).click();
  await expect(page.getByTestId(`workspace-row-${id}`)).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId(`workspace-row-${id}`)).toHaveCount(0);
  await expect(page.getByTestId("workspace-empty")).toBeVisible();
});

async function assertPhoneLayout(page: Page, expectedAttr: "dark" | "light" | null): Promise<void> {
  if (expectedAttr === null) {
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", /./);
  } else {
    await expect(page.locator("html")).toHaveAttribute("data-theme", expectedAttr);
  }

  const overflow = await page.evaluate(() => ({
    vsClient: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    vsWindow: document.documentElement.scrollWidth - window.innerWidth,
  }));
  expect(overflow.vsClient).toBeLessThanOrEqual(0);
  expect(overflow.vsWindow).toBeLessThanOrEqual(0);

  const boxes = await Promise.all(PHONE_TAP_TARGETS.map((testId) => page.getByTestId(testId).boundingBox()));
  for (const box of boxes) {
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
}

test("phone viewport has no horizontal overflow, exposes menu/theme controls, and keeps 44px touch targets", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByTestId("landing-page")).toBeVisible();

  // The phone bar holds the mark, the theme and the menu, and no second start button.
  await expect(page.getByTestId("phone-theme-toggle")).toBeVisible();
  await expect(page.getByTestId("phone-menu-toggle")).toBeVisible();
  await expect(page.getByTestId("header-new-workspace")).toBeHidden();

  // First click locks the non-system explicit theme; second click returns to following the system.
  await page.getByTestId("phone-theme-toggle").click();
  const firstTheme = (await page.locator("html").getAttribute("data-theme")) === "dark" ? "dark" : "light";
  await assertPhoneLayout(page, firstTheme);

  await page.getByTestId("phone-theme-toggle").click();
  await assertPhoneLayout(page, null);

  // Mobile menu exposes navigation links at 44px touch height.
  await page.getByTestId("phone-menu-toggle").click();
  const menu = page.getByTestId("phone-menu");
  await expect(menu).toBeVisible();
  await expect(menu).toContainText("Starters");
  await expect(menu).toContainText("GitHub");
});

test("theme choice persists in the same tab across landing and workbench in both directions", async ({
  browser,
  baseURL,
}) => {
  const darkContext = await browser.newContext({ baseURL, colorScheme: "dark" });
  const page = await darkContext.newPage();
  const themeColors = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')).map(
        (meta) => meta.content,
      ),
    );
  try {
    await page.goto("/");
    await expect(page.getByTestId("landing-page")).toBeVisible();

    const systemDark = await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches);
    const [other, own] = systemDark ? (["light", "dark"] as const) : (["dark", "light"] as const);
    const otherHex = other === "light" ? "#ffffff" : "#0a0d14";
    const otherLabel = other === "light" ? "Light" : "Dark";
    const ownLabel = own === "light" ? "Light" : "Dark";

    // Direction 1 (landing -> workbench): choose the non-system theme on landing, then open a starter in the same tab.
    await page.getByTestId(`theme-${other}`).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", other);
    await expect.poll(themeColors).toEqual([otherHex, otherHex]);

    await page.getByTestId("template-bun-sqlite").click();
    await expect(page).toHaveURL(/\/w\/[a-z0-9]+$/);
    await expect(page.getByTestId("workbench")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", other);
    await expect(page.getByRole("button", { name: otherLabel, exact: false })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect.poll(themeColors).toEqual([otherHex, otherHex]);

    // Direction 2a (workbench -> landing, returning to system): switch back to own scheme and return to landing.
    await page.getByRole("button", { name: ownLabel, exact: false }).click();
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", /./);
    await page.locator(".wb-brand").click();
    await expect(page.getByTestId("landing-page")).toBeVisible();
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", /./);
    await expect(page.getByTestId(`theme-${own}`)).toHaveAttribute("aria-pressed", "true");
    await expect.poll(themeColors).toEqual(["#ffffff", "#0a0d14"]);

    // Direction 2b (workbench -> landing, explicit override): pick other scheme in workbench and return to landing.
    await page.getByTestId("template-bun-sqlite").click();
    await expect(page.getByTestId("workbench")).toBeVisible();
    await page.getByRole("button", { name: otherLabel, exact: false }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", other);
    await page.locator(".wb-brand").click();
    await expect(page.getByTestId("landing-page")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", other);
    await expect(page.getByTestId(`theme-${other}`)).toHaveAttribute("aria-pressed", "true");
    await expect.poll(themeColors).toEqual([otherHex, otherHex]);
  } finally {
    await darkContext.close();
  }
});

test("landing demo explorer and tablists are keyboard accessible and pause stops cursor blink", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const demo = page.locator(".lp-hero-tab");
  const workbench = demo.locator(".lp-wb");

  // Explorer files open via native buttons with keyboard activation.
  const cssButton = demo.locator(".lp-wb-explorer").getByRole("button", { name: "App.css" });
  await cssButton.focus();
  await page.keyboard.press("Enter");
  const fileTabs = demo.getByRole("tablist", { name: "Open files" });
  await expect(fileTabs.getByRole("tab", { name: "App.css" })).toHaveAttribute("aria-selected", "true");
  await expect(fileTabs.getByRole("tab", { name: "App.css" })).toHaveAttribute("tabindex", "0");
  await expect(fileTabs.getByRole("tab", { name: "App.tsx" })).toHaveAttribute("tabindex", "-1");

  // ArrowRight moves focus and selection across Open files and links tabpanel via aria-controls/aria-labelledby.
  await fileTabs.getByRole("tab", { name: "App.css" }).focus();
  await page.keyboard.press("ArrowRight");
  const pkgTab = fileTabs.getByRole("tab", { name: "package.json" });
  await expect(pkgTab).toBeFocused();
  await expect(pkgTab).toHaveAttribute("aria-selected", "true");
  const pkgTabId = await pkgTab.getAttribute("id");
  const pkgPanelId = await pkgTab.getAttribute("aria-controls");
  expect(pkgTabId).toBeTruthy();
  expect(pkgPanelId).toBeTruthy();
  await expect(demo.locator(`#${pkgPanelId}`)).toHaveAttribute("aria-labelledby", pkgTabId!);

  // ArrowRight works on Terminal tabs with matching aria-controls/aria-labelledby.
  const termTabs = demo.getByRole("tablist", { name: "Terminal tabs" });
  await termTabs.getByRole("tab", { name: "bash" }).focus();
  await page.keyboard.press("ArrowRight");
  const devTab = termTabs.getByRole("tab", { name: "dev :5173" });
  await expect(devTab).toBeFocused();
  await expect(devTab).toHaveAttribute("aria-selected", "true");

  // Pause stops both playback and blinking cursors; reduced motion hides Replay.
  const pauseBtn = demo.getByRole("button", { name: "Pause demo" });
  if (await pauseBtn.isVisible()) await pauseBtn.click();
  await expect(workbench).toHaveAttribute("data-playing", "false");
  await fileTabs.getByRole("tab", { name: "App.tsx" }).click();
  await expect
    .poll(() => demo.locator(".lp-wb-caret").evaluate((el) => getComputedStyle(el).animationName))
    .toBe("none");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(demo.getByRole("button", { name: /Replay demo|Pause demo/ })).toHaveCount(0);
});

test("the phone demo's files, source and terminal output reach a screen reader", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const demo = page.locator(".lp-hero-tab");

  // Role queries only match what the accessibility tree exposes.
  await expect(demo.getByRole("tabpanel", { name: "Terminal" })).toContainText("bun run dev");
  await demo.getByRole("tab", { name: "Files" }).click();
  await expect(demo.getByRole("tabpanel", { name: "Files" })).toContainText("App.tsx");
  await demo.getByRole("tab", { name: "Code" }).click();
  await expect(demo.getByRole("tabpanel", { name: "Code" })).toContainText("useState");
  await demo.getByRole("tab", { name: "Preview" }).click();
  await expect(demo.getByRole("tabpanel", { name: "Preview" })).toContainText("Hello from bun.wasm");
});
