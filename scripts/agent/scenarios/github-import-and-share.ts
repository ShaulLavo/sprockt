import { assertPageNotProduction, installProductionGuard, verifyNonProductionUrl } from "../guard.ts";
import { SELECTORS } from "../selectors.ts";
import { assertCondition, waitForWorkbenchReady, type AgentScenario } from "./types.ts";

export const githubImportAndShareScenario: AgentScenario = {
  name: "github-import-and-share",
  description:
    "Verify landing repo input validation and offline-safe workspace Share link (/s#share=...) round-trip in a fresh browser context.",
  readOnly: false,
  defaultViewport: "desktop",
  async run(ctx) {
    const { browser, page, baseUrl, args, evidence } = ctx;
    await page.goto(baseUrl, { waitUntil: "networkidle" });

    // 1. Validate invalid repo input produces an accessible error without navigating away.
    await page.locator(SELECTORS.landing.repoInput).fill("not-a-valid-repo");
    await page.locator(SELECTORS.landing.repoSubmit).click();
    const errorText = (await page.locator(SELECTORS.landing.repoError).innerText()).trim();
    assertCondition(errorText.length > 0, "Expected inline validation message for invalid repo input");
    await evidence.capture(page, "invalid-repo-error");

    // 2. Open a starter, edit a file, capture a real share URL via the Share command, and restore it in a fresh context.
    await page.locator(SELECTORS.landing.templateCard("vanilla")).click();
    await page.waitForURL(/\/w\/[a-z0-9]+$/, { timeout: 30_000 });
    await waitForWorkbenchReady(page, args.timeoutMs);

    const marker = "shared-from-verify-sprockt";
    await page.evaluate(async (text) => {
      await globalThis.sprockt?.workspace?.files.write("share-marker.txt", text);
    }, marker);

    const shareButton = page.locator(SELECTORS.workbench.shareButton);
    await shareButton.waitFor({ state: "visible", timeout: 10_000 });
    await shareButton.click();
    const shareInput = page.locator(SELECTORS.workbench.shareLinkInput);
    await shareInput.waitFor({ state: "visible", timeout: 15_000 });

    const copiedUrl = await shareInput.inputValue();
    assertCondition(
      copiedUrl.includes("/s#share="),
      `Expected Share button to produce a /s#share= URL, got "${copiedUrl.slice(0, 80)}"`,
    );
    await verifyNonProductionUrl(copiedUrl, "github-import-and-share");
    await evidence.capture(page, "share-link-copied");

    const restoredCtx = await browser.newContext({
      viewport: { width: args.viewport.width, height: args.viewport.height },
      colorScheme: args.scheme,
    });
    try {
      await installProductionGuard(restoredCtx);
      const restoredPage = await restoredCtx.newPage();
      evidence.attach(restoredPage);
      await restoredPage.goto(copiedUrl, { waitUntil: "networkidle" });
      assertPageNotProduction(restoredPage, "github-import-and-share");
      await restoredPage.waitForURL(/\/w\/[a-z0-9]+$/, { timeout: 30_000 });
      await waitForWorkbenchReady(restoredPage, args.timeoutMs);
      const restoredContent = await restoredPage.evaluate(() =>
        globalThis.sprockt?.workspace?.files.read("share-marker.txt"),
      );
      assertCondition(
        restoredContent === marker,
        `Expected restored file "${marker}", got "${restoredContent}"`,
      );
      await evidence.capture(restoredPage, "share-restored-in-fresh-context");
      evidence.writeJson("layout.json", await evidence.snapshotLayout(restoredPage));
    } finally {
      await restoredCtx.close();
    }

    evidence.notes.push("Landing repo input validation error verified.");
    evidence.notes.push("Share snapshot URL restored exact workspace content in a fresh isolated context.");
  },
};
