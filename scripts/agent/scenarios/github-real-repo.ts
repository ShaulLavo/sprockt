import { expect, type Page } from "@playwright/test";
import { startBootTiming } from "../boot-timing.ts";
import { SELECTORS } from "../selectors.ts";
import { waitForWorkbenchReady, type AgentScenario } from "./types.ts";

const REPO = "https://github.com/darkmatter/canonical/tree/3278b2558e7771685f56464d7655f4628919fadd";
const EFFECT_VERSION = "4.0.0-beta.102";

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

export async function importRealRepo(page: Page, baseUrl: string, timeout: number) {
  await page.goto(baseUrl);
  await page.locator(SELECTORS.landing.repoInput).fill(REPO);
  const timing = startBootTiming();
  await page.locator(SELECTORS.landing.repoSubmit).click();
  await page.waitForURL(/\/w\/[a-z0-9]+$/, { timeout });
  timing.mark("importedMs");
  await waitForWorkbenchReady(page, timeout);
  timing.mark("workbenchReadyMs");

  await expect
    .poll(() => page.evaluate(() => globalThis.sprockt?.workspace?.devServer.output()), {
      message: "Bun completed the workspace install",
      timeout,
    })
    .toMatch(/\d+ packages installed/);
  const version = new RegExp(`"version"\\s*:\\s*"${EFFECT_VERSION.replaceAll(".", "\\.")}"`);
  expect(await installedPackages(page)).toEqual([
    expect.stringMatching(version),
    expect.stringMatching(version),
    expect.stringMatching(/"name"\s*:\s*"@repo\/web-core"/),
  ]);
  timing.mark("installedMs");

  const phonePreview = page.locator(SELECTORS.workbench.paneButton("Preview"));
  if (await phonePreview.isVisible()) await phonePreview.click();
  const task = page.locator(SELECTORS.preview.task);
  if ((await task.getAttribute("data-status")) !== "stopped") await task.click();
  await expect(task).toHaveAttribute("data-status", "stopped", { timeout });
  await page.locator(SELECTORS.preview.emptyTarget).selectOption("apps/web:dev", { timeout });
  await page.locator(SELECTORS.preview.startButton).click();
  await expect(page.locator(SELECTORS.preview.port)).toHaveValue("3000", { timeout });
  timing.mark("serverListeningMs");
  const preview = page.frameLocator(SELECTORS.preview.frame);
  await expect(preview.getByRole("heading", { name: "Ops monorepo demo" })).toBeVisible({ timeout });
  await expect(preview.locator("#status")).toContainText("development", { timeout });
  await expect(preview.locator("#status")).toContainText("ok", { timeout });
  timing.mark("previewRenderedMs");
  return timing.report(page);
}

export const githubRealRepoScenario: AgentScenario = {
  name: "github-real-repo",
  description:
    "Import a pinned GitHub monorepo, install its catalogs and overrides with Bun, and serve its web app.",
  readOnly: false,
  live: true,
  async run({ page, baseUrl, args, evidence }) {
    const report = await importRealRepo(page, baseUrl, args.timeoutMs);
    evidence.writeJson("cold-boot.json", report);
    evidence.notes.push(
      "Bun installed the catalog and override versions, linked the workspace package, and served the web app.",
    );
    await evidence.capture(page, "github-repo-installed-and-running");
    evidence.writeJson("layout.json", await evidence.snapshotLayout(page));
  },
};
