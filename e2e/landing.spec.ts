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
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("An IDE that runs in a browser tab");

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

interface Box {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

function findHubOverlaps(
  frame: Box,
  boxes: readonly { readonly label: string; readonly rect: Box }[],
): string[] {
  const issues: string[] = [];
  for (const a of boxes) {
    const out =
      a.rect.left < frame.left - 1 ||
      a.rect.right > frame.right + 1 ||
      a.rect.top < frame.top - 1 ||
      a.rect.bottom > frame.bottom + 1;
    if (out) issues.push(`out-of-bounds:${a.label}`);
  }
  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i]!;
    for (let j = i + 1; j < boxes.length; j++) {
      const b = boxes[j]!;
      const xOverlap = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
      const yOverlap = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
      if (xOverlap > 0.5 && yOverlap > 0.5) issues.push(`${a.label}<>${b.label}`);
    }
  }
  return issues;
}

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
  await page.getByTestId("phone-menu-toggle").click();

  // At phone width the Waffle hub pills stay inside the diagram frame and never overlap each other.
  const hub = page.getByTestId("hub-diagram");
  await hub.scrollIntoViewIfNeeded();
  await expect.poll(() => hub.locator(".lp-dg-svg").count()).toBe(1);
  const hubGeometry = await hub.evaluate((root) => {
    const f = root.getBoundingClientRect();
    return {
      frame: { left: f.left, right: f.right, top: f.top, bottom: f.bottom },
      boxes: Array.from(root.querySelectorAll<HTMLElement>(".lp-dg-node"), (el) => {
        const r = el.getBoundingClientRect();
        return {
          label: el.textContent?.trim() ?? "",
          rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
        };
      }),
    };
  });
  expect(hubGeometry.boxes.length).toBe(7);
  expect(findHubOverlaps(hubGeometry.frame, hubGeometry.boxes)).toEqual([]);
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

test("desktop nav is dead-centered, showcases are inert, animations have WCAG pause controls, and all logos load eagerly", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.getByTestId("landing-page")).toBeVisible();

  // Desktop nav links sit dead-centered over the H1.
  const navBox = await page.getByTestId("desktop-nav").boundingBox();
  const h1Box = await page.getByRole("heading", { level: 1 }).boundingBox();
  expect(navBox).not.toBeNull();
  expect(h1Box).not.toBeNull();
  const navCenter = navBox!.x + navBox!.width / 2;
  const h1Center = h1Box!.x + h1Box!.width / 2;
  expect(Math.abs(navCenter - h1Center)).toBeLessThan(2);

  // Hero and iPhone showcases are decorative inert visuals with zero focusable descendants.
  await Promise.all(
    (["hero-showcase", "phone-showcase"] as const).map(async (testId) => {
      const showcase = page.getByTestId(testId);
      await expect(showcase).toHaveAttribute("role", "img");
      const focusables = await showcase.evaluate((el) => {
        const inner = el.querySelector("[inert]");
        return {
          hasInert: Boolean(inner),
          buttons: el.querySelectorAll("button, a, input, [tabindex]").length,
        };
      });
      expect(focusables.hasInert).toBe(true);
      expect(focusables.buttons).toBe(0);
    }),
  );

  // All 4 feature cards render distinct painterly-landscape backdrops.
  await Promise.all(
    (["check", "complete", "terminal", "store"] as const).map((tone) =>
      expect(page.getByTestId(`feature-card-${tone}`)).toBeVisible(),
    ),
  );

  // Hero grain-gradient exposes a WCAG pause control when WebGL is live, and hides it on fallback.
  const heroFallback = await page.locator(".lp-hero-backdrop").getAttribute("data-fx-fallback");
  if (heroFallback === "1") {
    await expect(page.getByTestId("hero-fx-pause")).toHaveCount(0);
  } else {
    const heroBtn = page.getByTestId("hero-fx-pause");
    await expect(heroBtn).toBeVisible();
    await expect(heroBtn).toHaveAttribute("aria-pressed", "false");
    await heroBtn.click();
    await expect(heroBtn).toHaveAttribute("aria-pressed", "true");
    await heroBtn.click();
    await expect(heroBtn).toHaveAttribute("aria-pressed", "false");
  }

  // Waffle hub diagram places its pause button outside role="img", freezes the current frame
  // without resetting or advancing while paused, and resumes cleanly from that exact frame.
  const hub = page.getByTestId("hub-diagram");
  await hub.scrollIntoViewIfNeeded();
  await expect(hub.locator('[role="img"]')).toHaveCount(1);
  const hubBtn = page.getByTestId("hub-pause");
  await expect(hubBtn).toBeVisible();
  expect(await hubBtn.evaluate((el) => el.closest('[role="img"]') === null)).toBe(true);

  const hubSnapshot = () =>
    hub.evaluate((root) =>
      Array.from(root.querySelectorAll<SVGLineElement>(".lp-dg-comet, .lp-dg-lit"), (el) => [
        el.getAttribute("stroke-dashoffset") ?? "",
        el.getAttribute("stroke-dasharray") ?? "",
        el.style.opacity,
      ]),
    );

  // Let the hub advance off its initial still frame before testing pause/resume continuity.
  const initialFrame = await hubSnapshot();
  await expect.poll(hubSnapshot).not.toEqual(initialFrame);

  // Gate requestAnimationFrame around both clicks so we observe the exact frame across pause
  // and on the first resumed tick (proving neither pause nor resume resets the clock).
  const pauseResumeCheck = await hub.evaluate(async (root) => {
    const readFrame = () =>
      Array.from(root.querySelectorAll<SVGLineElement>(".lp-dg-comet, .lp-dg-lit"), (el) => [
        el.getAttribute("stroke-dashoffset") ?? "",
        el.getAttribute("stroke-dasharray") ?? "",
        el.style.opacity,
      ]);
    const btn = root.querySelector<HTMLButtonElement>('[data-testid="hub-pause"]');
    if (!btn) throw new Error("Missing hub-pause button");

    const origRaf = window.requestAnimationFrame.bind(window);
    const origCancel = window.cancelAnimationFrame.bind(window);
    let nextId = 1;
    const held = new Map<number, FrameRequestCallback>();
    const holdRaf = () => {
      window.requestAnimationFrame = (cb) => {
        const id = nextId++;
        held.set(id, cb);
        return id;
      };
      window.cancelAnimationFrame = (id) => {
        if (!held.delete(id)) origCancel(id);
      };
    };
    const flushHeld = (ts: number): number => {
      const cbs = Array.from(held.values());
      held.clear();
      for (const cb of cbs) cb(ts);
      return cbs.length;
    };
    const releaseRaf = () => {
      window.requestAnimationFrame = origRaf;
      window.cancelAnimationFrame = origCancel;
      const queued = Array.from(held.values());
      held.clear();
      for (const cb of queued) origRaf(cb);
    };

    try {
      holdRaf();
      const beforePause = readFrame();
      btn.click();
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
      const afterPause = readFrame();
      const pausedPressed = btn.getAttribute("aria-pressed");
      const hasPausedClass = root.classList.contains("is-paused");

      releaseRaf();
      for (let i = 0; i < 10; i++) {
        // oxlint-disable-next-line no-await-in-loop
        await new Promise<void>((resolve) => origRaf(() => resolve()));
      }
      const laterWhilePaused = readFrame();

      holdRaf();
      btn.click();
      for (let tries = 0; tries < 25 && held.size === 0; tries++) {
        // oxlint-disable-next-line no-await-in-loop
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      const resumedPressed = btn.getAttribute("aria-pressed");
      const now = performance.now();
      const firstTickCount = flushHeld(now);
      const firstResumed = readFrame();

      // Advance only the callbacks scheduled inside the gate to prove the hub loop itself resumed.
      let laterTickCount = 0;
      for (let step = 1; step <= 25; step++) {
        laterTickCount += flushHeld(now + step * 40);
      }
      const afterGatedTicks = readFrame();

      releaseRaf();
      return {
        beforePause,
        afterPause,
        laterWhilePaused,
        firstResumed,
        afterGatedTicks,
        firstTickCount,
        laterTickCount,
        pausedPressed,
        hasPausedClass,
        resumedPressed,
      };
    } finally {
      releaseRaf();
    }
  });

  expect(pauseResumeCheck.pausedPressed).toBe("true");
  expect(pauseResumeCheck.hasPausedClass).toBe(true);
  expect(pauseResumeCheck.beforePause).not.toEqual(initialFrame);
  expect(pauseResumeCheck.afterPause).toEqual(pauseResumeCheck.beforePause);
  expect(pauseResumeCheck.laterWhilePaused).toEqual(pauseResumeCheck.beforePause);
  expect(pauseResumeCheck.resumedPressed).toBe("false");
  expect(pauseResumeCheck.firstTickCount).toBeGreaterThan(0);
  expect(pauseResumeCheck.laterTickCount).toBeGreaterThan(0);
  expect(pauseResumeCheck.firstResumed).toEqual(pauseResumeCheck.beforePause);
  expect(pauseResumeCheck.afterGatedTicks).not.toEqual(pauseResumeCheck.beforePause);

  // All landing page <img> assets (browser logos, hub logos, template icons) load eagerly.
  const brokenImages = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLImageElement>("img"))
      .filter((img) => !img.complete || img.naturalWidth === 0)
      .map((img) => img.src),
  );
  expect(brokenImages).toEqual([]);

  // Under prefers-reduced-motion: reduce, looping pause controls hide cleanly.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.getByTestId("hero-fx-pause")).toHaveCount(0);
  await expect(page.getByTestId("hub-pause")).toHaveCount(0);
});

test("hero hides its pause control when WebGL is unavailable and static fallback is active", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    const origGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      type: string,
      ...args: unknown[]
    ) {
      if (type === "webgl2" || type === "webgl" || type === "experimental-webgl") return null;
      return origGetContext.apply(this, [type, ...args] as Parameters<typeof origGetContext>);
    } as typeof HTMLCanvasElement.prototype.getContext;
  });
  await page.goto("/");
  await expect(page.getByTestId("landing-page")).toBeVisible();
  await expect(page.locator(".lp-hero-backdrop")).toHaveAttribute("data-fx-fallback", "1");
  await expect(page.getByTestId("hero-fx-pause")).toHaveCount(0);
});
