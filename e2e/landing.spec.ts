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
  "header-new-workspace",
  "hero-start-cta",
  "repo-submit",
  "new-workspace",
  "theme-light",
  "theme-dark",
  "template-vite-react",
  "template-hono",
] as const;

test("landing renders cleanly without loading workbench code and opens GitHub routes", async ({ page }) => {
  const loadedScripts: string[] = [];
  page.on("response", (response) => {
    const url = response.url();
    if (url.includes("/assets/") && url.endsWith(".js")) loadedScripts.push(url);
  });

  await page.goto("/");
  await expect(page.getByTestId("landing-page")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Real Bun in any browser tab.");

  // All seven starter templates are visible and interactive.
  await Promise.all(TEMPLATE_IDS.map((id) => expect(page.getByTestId(`template-${id}`)).toBeVisible()));

  // The workbench bundle stays lazy on the landing page.
  expect(loadedScripts.some((url) => url.includes("Workbench-"))).toBe(false);

  // Invalid repo input shows an inline error; valid GitHub URLs navigate to /github/...
  await page.getByTestId("repo-input").fill("not a valid repo");
  await page.getByTestId("repo-submit").click();
  await expect(page.getByTestId("repo-error")).toBeVisible();

  await page.getByTestId("repo-input").fill("https://github.com/oven-sh/bun/tree/main/examples/vite");
  await page.getByTestId("repo-submit").click();
  await expect(page).toHaveURL(/\/github\/oven-sh\/bun\/tree\/main\/examples\/vite$/);

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

  await page.getByRole("button", { name: "App.tsx" }).click();
  await expect(page.getByTestId("editor-file")).toHaveText("src/App.tsx");
  await expect.poll(() => editorText(page)).toContain("Hello from bun.wasm");

  // Reloading preserves the seeded template files in IndexedDB.
  await page.reload();
  await expect(page.getByTestId("file-tree")).toContainText("App.tsx");
  await expect(page.getByTestId("file-tree")).toContainText("package.json");
  await page.getByRole("button", { name: "App.tsx" }).click();
  await expect.poll(() => editorText(page)).toContain("Hello from bun.wasm");
});

test("workspace switcher lists, detects another open tab, renames, and deletes a workspace", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await page.getByTestId("template-bun-sqlite").click();
  await expect(page).toHaveURL(/\/w\/[a-z0-9]+$/);
  const id = new URL(page.url()).pathname.slice("/w/".length);
  await expect(page.getByTestId("file-tree")).toContainText("server.ts");
  await expect(page.getByTestId("save-state")).toHaveText("saved");

  // Return to landing and verify the workspace appears with its metadata from workspace.json.
  await page.goto("/");
  const row = page.getByTestId(`workspace-row-${id}`);
  await expect(row).toBeVisible();
  await expect(row).toContainText("sqlite-notes");
  await expect(row).toContainText("Bun.serve + SQLite");

  // Rename persists in /.sprockt/workspace.json across reloads.
  await page.getByTestId(`workspace-rename-${id}`).click();
  await page.getByTestId(`workspace-rename-input-${id}`).fill("notes-api");
  await page.getByTestId(`workspace-rename-save-${id}`).click();
  await expect(row).toContainText("notes-api");

  await page.reload();
  await expect(page.getByTestId(`workspace-row-${id}`)).toContainText("notes-api");

  // Opening the workspace in another tab surfaces the live indicator on the landing page.
  const otherTab = await context.newPage();
  await otherTab.goto(`/w/${id}`);
  await expect(otherTab.getByTestId("file-tree")).toContainText("server.ts");

  await page.reload();
  await expect(page.getByTestId(`workspace-live-${id}`)).toHaveText("Open in another tab");
  await otherTab.close();

  // Once closed elsewhere, wait until the lock clears, then delete with confirmation.
  await expect
    .poll(async () => {
      await page.reload();
      await expect(page.getByTestId(`workspace-row-${id}`)).toBeVisible();
      return page.getByTestId(`workspace-live-${id}`).count();
    })
    .toBe(0);
  await page.getByTestId(`workspace-delete-${id}`).click();
  await expect(page.getByTestId(`workspace-confirm-delete-${id}`)).toBeVisible();
  await page.getByTestId(`workspace-delete-confirm-${id}`).click();
  await expect(page.getByTestId(`workspace-row-${id}`)).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId(`workspace-row-${id}`)).toHaveCount(0);
  await expect(page.getByTestId("workspace-empty")).toBeVisible();
});

async function assertPhoneLayout(page: Page, theme: "dark" | "light"): Promise<void> {
  await page.getByTestId(`theme-${theme}`).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  const boxes = await Promise.all(PHONE_TAP_TARGETS.map((testId) => page.getByTestId(testId).boundingBox()));
  for (const box of boxes) {
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
}

test("phone viewport has no horizontal overflow and maintains 44px touch targets in both themes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByTestId("landing-page")).toBeVisible();
  await assertPhoneLayout(page, "dark");
  await assertPhoneLayout(page, "light");
});
