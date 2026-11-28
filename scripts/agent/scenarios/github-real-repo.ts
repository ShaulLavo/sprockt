import { expect, type Page } from "@playwright/test";
import { startBootTiming } from "../boot-timing.ts";
import { SELECTORS } from "../selectors.ts";
import { waitForWorkbenchReady, type AgentScenario } from "./types.ts";

const CATALOG_REPO = "https://github.com/darkmatter/canonical/tree/3278b2558e7771685f56464d7655f4628919fadd";
const VITE_REPO =
  "https://github.com/vitejs/vite/tree/dd44573ca4df1546d8da17b6956d6a8b1e4cf821/packages/create-vite/template-vanilla-ts";
const EFFECT_VERSION = /"version"\s*:\s*"4\.0\.0-beta\.102"/;

async function openRepo(page: Page, baseUrl: string, repo: string, timeout: number) {
  await page.goto(baseUrl);
  await page.locator(SELECTORS.landing.repoInput).fill(repo);
  const timing = startBootTiming();
  await page.locator(SELECTORS.landing.repoSubmit).click();
  await page.waitForURL(/\/w\/[a-z0-9]+$/, { timeout });
  timing.mark("importedMs");
  await waitForWorkbenchReady(page, timeout);
  timing.mark("workbenchReadyMs");
  return timing;
}

async function installedPackages(page: Page): Promise<readonly (string | undefined)[]> {
  return page.evaluate(async () => {
    const workspace = globalThis.sprockt?.workspace;
    if (!workspace) throw new Error("Workspace is not ready");
    return Promise.all([
      workspace.files.read("node_modules/effect/package.json"),
      workspace.files.read("node_modules/@effect/platform-node-shared/package.json"),
      workspace.files.read("node_modules/@repo/web-core/package.json"),
    ]);
  });
}

async function installCatalogWorkspace(page: Page, baseUrl: string, timeout: number) {
  const timing = await openRepo(page, baseUrl, CATALOG_REPO, timeout);
  await expect
    .poll(() => page.evaluate(() => globalThis.sprockt?.workspace?.devServer.output()), {
      message: "Bun completed the workspace install",
      timeout,
    })
    .toMatch(/\d+ packages installed/);
  expect(await installedPackages(page)).toEqual([
    expect.stringMatching(EFFECT_VERSION),
    expect.stringMatching(EFFECT_VERSION),
    expect.stringMatching(/"name"\s*:\s*"@repo\/web-core"/),
  ]);
  timing.mark("installedMs");
  return timing.report(page);
}

async function serveImportedViteApp(page: Page, baseUrl: string, timeout: number) {
  const timing = await openRepo(page, baseUrl, VITE_REPO, timeout);
  await expect(page.locator(SELECTORS.explorer.tree)).toContainText("bun.lock", { timeout });
  timing.mark("installLockfileMs");
  await expect(page.locator(SELECTORS.preview.port)).toHaveValue("5173", { timeout });
  timing.mark("serverListeningMs");

  const phonePreview = page.locator(SELECTORS.workbench.paneButton("Preview"));
  if (await phonePreview.isVisible()) await phonePreview.click();
  const frame = page.frameLocator(SELECTORS.preview.frame);
  await expect(frame.getByRole("heading", { name: "Vite + TypeScript" })).toBeVisible({ timeout });
  timing.mark("previewRenderedMs");
  await frame.getByRole("button", { name: "count is 0" }).click();
  await expect(frame.getByRole("button", { name: "count is 1" })).toBeVisible({ timeout });
  return timing.report(page);
}

export async function importRealRepo(page: Page, baseUrl: string, timeout: number) {
  const catalogs = await installCatalogWorkspace(page, baseUrl, timeout);
  const preview = await serveImportedViteApp(page, baseUrl, timeout);
  return { catalogs, preview };
}

export const githubRealRepoScenario: AgentScenario = {
  name: "github-real-repo",
  description:
    "Install a pinned GitHub monorepo with catalogs and overrides, then import and run a Vite app.",
  readOnly: false,
  live: true,
  async run({ page, baseUrl, args, evidence }) {
    const report = await importRealRepo(page, baseUrl, args.timeoutMs);
    evidence.writeJson("cold-boot.json", report);
    evidence.notes.push(
      "Bun installed the catalog and override versions, linked the workspace package, and served the imported Vite app.",
    );
    await evidence.capture(page, "github-repo-installed-and-running");
    evidence.writeJson("layout.json", await evidence.snapshotLayout(page));
  },
};
