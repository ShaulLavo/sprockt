import type { BrowserContext, Frame, Page, Route } from "@playwright/test";
import { isProductionUrl } from "./args.ts";

function closePageQuietly(page: Page): void {
  void page.close().catch(ignoreError);
}

function ignoreError(): void {
  // Best-effort cleanup.
}

function handleMainFrameNavigation(page: Page, frame: Frame): void {
  if (frame !== page.mainFrame()) return;
  if (!isProductionUrl(frame.url())) return;
  closePageQuietly(page);
}

function attachFrameGuard(page: Page): void {
  page.on("framenavigated", (frame) => handleMainFrameNavigation(page, frame));
}

async function handleRoute(route: Route): Promise<void> {
  const req = route.request();
  const isMainDoc = req.isNavigationRequest() && req.frame().parentFrame() === null;
  if (isMainDoc && isProductionUrl(req.url())) {
    await route.abort("blockedbyclient");
    return;
  }
  await route.continue();
}

export async function verifyNonProductionUrl(url: string, scenarioName: string): Promise<void> {
  if (isProductionUrl(url)) {
    throw new Error(`Refusing writing scenario "${scenarioName}" against production URL ${url}.`);
  }
  const response = await fetch(url, { method: "HEAD", redirect: "follow" }).catch(() => null);
  const finalUrl = response?.url;
  if (finalUrl && isProductionUrl(finalUrl)) {
    throw new Error(
      `Refusing writing scenario "${scenarioName}": ${url} redirects to production URL ${finalUrl}.`,
    );
  }
}

export async function installProductionGuard(context: BrowserContext): Promise<void> {
  await context.route("**/*", handleRoute);
  context.on("page", attachFrameGuard);
}

export function assertPageNotProduction(page: Page, scenarioName: string): void {
  if (isProductionUrl(page.url())) {
    throw new Error(
      `Refusing writing scenario "${scenarioName}": navigated to production URL ${page.url()}.`,
    );
  }
}
