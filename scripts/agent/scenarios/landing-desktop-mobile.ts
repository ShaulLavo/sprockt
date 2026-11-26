import { VIEWPORT_PRESETS } from "../args.ts";
import { SELECTORS } from "../selectors.ts";
import { assertCondition, type AgentScenario } from "./types.ts";

const EXPECTED_STARTERS = [
  "vite-react",
  "next-app",
  "hono",
  "astro",
  "sveltekit",
  "vanilla",
  "bun-sqlite",
] as const;

export const landingDesktopMobileScenario: AgentScenario = {
  name: "landing-desktop-mobile",
  description: "Verify landing page on desktop (1440x900) and phone (390x844) across light and dark themes.",
  readOnly: true,
  async run(ctx) {
    const { browser, baseUrl, evidence } = ctx;
    const checks: Record<string, unknown> = {};

    const desktopCtx = await browser.newContext({
      viewport: { width: VIEWPORT_PRESETS.desktop.width, height: VIEWPORT_PRESETS.desktop.height },
      colorScheme: "light",
    });
    try {
      const page = await desktopCtx.newPage();
      evidence.attach(page);
      await page.goto(baseUrl, { waitUntil: "networkidle" });
      await page.waitForSelector(SELECTORS.landing.page);
      await page.evaluate(() => document.fonts.ready);

      const desktopLight = await evidence.snapshotLayout(page);
      assertCondition(desktopLight.crossOriginIsolated, "Expected crossOriginIsolated=true on landing page");
      assertCondition(desktopLight.overflowX === 0, `Desktop light overflowX=${desktopLight.overflowX}`);
      assertCondition(
        desktopLight.brokenImages.length === 0,
        `Broken images: ${desktopLight.brokenImages.join(", ")}`,
      );
      const starterCounts = await Promise.all(
        EXPECTED_STARTERS.map(async (id) => ({
          id,
          count: await page.locator(SELECTORS.landing.templateCard(id)).count(),
        })),
      );
      for (const { id, count } of starterCounts) {
        assertCondition(count === 1, `Missing starter card "${id}" on landing page`);
      }
      await evidence.capture(page, "desktop-light-fold");
      await evidence.capture(page, "desktop-light-full", { fullPage: true });

      await page.locator(SELECTORS.landing.themeDark).click();
      await page.waitForTimeout(150);
      const desktopDark = await evidence.snapshotLayout(page);
      assertCondition(desktopDark.overflowX === 0, `Desktop dark overflowX=${desktopDark.overflowX}`);
      await evidence.capture(page, "desktop-dark-fold");
      await evidence.capture(page, "desktop-dark-full", { fullPage: true });
      checks.desktop = { light: desktopLight, dark: desktopDark };
    } finally {
      await desktopCtx.close();
    }

    const phoneCtx = await browser.newContext({
      viewport: { width: VIEWPORT_PRESETS.phone.width, height: VIEWPORT_PRESETS.phone.height },
      isMobile: true,
      hasTouch: true,
      colorScheme: "light",
    });
    try {
      const page = await phoneCtx.newPage();
      evidence.attach(page);
      await page.goto(baseUrl, { waitUntil: "networkidle" });
      await page.waitForSelector(SELECTORS.landing.page);
      await page.evaluate(() => document.fonts.ready);

      const phoneLight = await evidence.snapshotLayout(page);
      assertCondition(phoneLight.overflowX === 0, `Phone light overflowX=${phoneLight.overflowX}`);
      await evidence.capture(page, "phone-light-fold");
      await evidence.capture(page, "phone-light-full", { fullPage: true });

      await page.locator(SELECTORS.landing.phoneThemeToggle).tap();
      await page.waitForTimeout(150);
      const phoneDark = await evidence.snapshotLayout(page);
      assertCondition(phoneDark.overflowX === 0, `Phone dark overflowX=${phoneDark.overflowX}`);
      await evidence.capture(page, "phone-dark-fold");
      checks.phone = { light: phoneLight, dark: phoneDark };
    } finally {
      await phoneCtx.close();
    }

    evidence.writeJson("layout.json", checks);
    evidence.notes.push(
      "Desktop (1440x900) and phone (390x844) rendered with 0 horizontal overflow in light and dark modes.",
    );
    evidence.notes.push(`All ${EXPECTED_STARTERS.length} starter template cards are present and reachable.`);
  },
};
