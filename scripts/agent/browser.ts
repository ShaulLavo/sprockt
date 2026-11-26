import { resolve } from "node:path";
import {
  chromium,
  firefox,
  webkit,
  type Browser,
  type BrowserContext,
  type BrowserType,
  type Page,
  type Response,
} from "@playwright/test";
import {
  CLI_USAGE,
  parseCliArgs,
  VIEWPORT_PRESETS,
  type BrowserEngine,
  type ParsedArgs,
  type ViewportSpec,
} from "./args.ts";
import { createEvidenceSession, type EvidenceSession, type LayoutSnapshot } from "./evidence.ts";
import { assertPageNotProduction, installProductionGuard, verifyNonProductionUrl } from "./guard.ts";
import { findScenario, SCENARIOS } from "./scenarios/index.ts";
import { startThrowawayPreviewServer, type PreviewServerHandle } from "./server.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

function pickBrowserType(engine: BrowserEngine): BrowserType {
  if (engine === "webkit") return webkit;
  if (engine === "firefox") return firefox;
  return chromium;
}

async function resolveTarget(args: ParsedArgs, signal: AbortSignal): Promise<PreviewServerHandle> {
  if (args.url) {
    return {
      url: args.url,
      port: 0,
      owned: false,
      logs: () => "",
      stop: async () => {},
    };
  }
  return startThrowawayPreviewServer(REPO_ROOT, signal);
}

function collectDoctorProblems(
  response: Response | null,
  layout: LayoutSnapshot,
  observed: { readonly pageErrors: readonly string[]; readonly consoleErrors: readonly string[] },
): string[] {
  const problems: string[] = [];
  if (!response || !response.ok()) {
    problems.push(`navigation returned HTTP ${response ? response.status() : "none"}`);
  }
  if (layout.appSurface === "unknown") {
    problems.push("no Sprockt app surface marker found (expected landing-page, workbench, or import-page)");
  }
  if (!layout.crossOriginIsolated) problems.push("crossOriginIsolated is false (missing COOP/COEP headers)");
  if (layout.overflowX > 0) problems.push(`horizontal overflow detected (${layout.overflowX}px)`);
  if (layout.visibleAlerts.length > 0) problems.push(`visible alert(s): ${layout.visibleAlerts.join("; ")}`);
  if (layout.brokenImages.length > 0) problems.push(`broken image(s): ${layout.brokenImages.join(", ")}`);
  if (observed.pageErrors.length > 0) problems.push(`${observed.pageErrors.length} pageerror(s)`);
  if (observed.consoleErrors.length > 0) problems.push(`${observed.consoleErrors.length} console error(s)`);
  return problems;
}

function evaluateDoctor(
  evidence: EvidenceSession,
  response: Response | null,
  layout: LayoutSnapshot,
): "PASS" | "FAIL" {
  const problems = collectDoctorProblems(response, layout, evidence.observed);
  if (problems.length === 0) {
    evidence.notes.push(
      `Doctor healthy (${layout.appSurface}): HTTP ${response?.status()}, COOP/COEP active, 0 overflow, 0 alerts, 0 page/console errors.`,
    );
    return "PASS";
  }
  evidence.notes.push(...problems.map((item) => `Doctor failure: ${item}`));
  return "FAIL";
}

async function captureFailureQuietly(evidence: EvidenceSession, page: Page | undefined): Promise<void> {
  if (!page) return;
  try {
    await evidence.capture(page, "failure-state");
  } catch {
    // Page may already be closed or crashed.
  }
}

async function closeContextQuietly(
  context: BrowserContext | undefined,
  evidence: EvidenceSession,
): Promise<void> {
  if (!context) return;
  try {
    await context.close();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    evidence.notes.push(`Context close error: ${message}`);
  }
}

async function runLook(args: ParsedArgs, browser: Browser, target: PreviewServerHandle): Promise<boolean> {
  const label = `${args.doctor ? "doctor-" : ""}${args.viewport.label}-${args.scheme}-${args.engine}`;
  const evidence = createEvidenceSession("look", label, args.evidenceRoot);
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let status: "PASS" | "FAIL" = "PASS";
  let layout: LayoutSnapshot | undefined;
  try {
    context = await browser.newContext({
      viewport: { width: args.viewport.width, height: args.viewport.height },
      isMobile: args.viewport.isMobile,
      hasTouch: args.viewport.hasTouch,
      colorScheme: args.scheme,
    });
    page = await context.newPage();
    evidence.attach(page);
    const response = await page.goto(target.url, { waitUntil: "networkidle", timeout: args.timeoutMs });
    await page.evaluate(() => document.fonts.ready);
    layout = await evidence.snapshotLayout(page);
    evidence.writeJson("layout.json", layout);
    await evidence.capture(page, "viewport", { selector: args.selector });
    if (!args.selector) await evidence.capture(page, "full-page", { fullPage: true });
    if (args.doctor) status = evaluateDoctor(evidence, response, layout);
  } catch (error) {
    status = "FAIL";
    const message = error instanceof Error ? error.message : String(error);
    evidence.notes.push(`Look failed: ${message}`);
    await captureFailureQuietly(evidence, page);
  } finally {
    await closeContextQuietly(context, evidence);
  }
  if (target.owned) evidence.writeText("server.log", target.logs());
  const summary = evidence.finalize(status, {
    url: target.url,
    engine: args.engine,
    viewport: `${args.viewport.width}x${args.viewport.height}`,
    scheme: args.scheme,
    appSurface: layout?.appSurface ?? "unknown",
    crossOriginIsolated: layout?.crossOriginIsolated ?? false,
    overflowX: layout?.overflowX ?? -1,
  });
  console.log(summary);
  return status === "PASS";
}

async function runScenario(
  args: ParsedArgs,
  browser: Browser,
  target: PreviewServerHandle,
): Promise<boolean> {
  const scenario = findScenario(args.scenarioName ?? "");
  if (!scenario) {
    const names = SCENARIOS.map((item) => item.name).join(", ");
    throw new Error(`Unknown scenario "${args.scenarioName}". Available: ${names}`);
  }
  if (args.url && !scenario.readOnly) {
    await verifyNonProductionUrl(args.url, scenario.name);
  }
  const effectiveViewport: ViewportSpec =
    args.viewport === VIEWPORT_PRESETS.desktop && scenario.defaultViewport === "phone"
      ? VIEWPORT_PRESETS.phone
      : args.viewport;
  const evidence = createEvidenceSession("scenario", `${scenario.name}-${args.engine}`, args.evidenceRoot);
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let status: "PASS" | "FAIL" = "PASS";
  try {
    context = await browser.newContext({
      viewport: { width: effectiveViewport.width, height: effectiveViewport.height },
      isMobile: effectiveViewport.isMobile,
      hasTouch: effectiveViewport.hasTouch,
      colorScheme: args.scheme,
    });
    if (!scenario.readOnly) await installProductionGuard(context);
    page = await context.newPage();
    evidence.attach(page);
    await scenario.run({
      browser,
      page,
      baseUrl: target.url,
      args: { ...args, viewport: effectiveViewport },
      evidence,
    });
    if (!scenario.readOnly) assertPageNotProduction(page, scenario.name);
  } catch (error) {
    status = "FAIL";
    const message = error instanceof Error ? error.message : String(error);
    evidence.notes.push(`Scenario failed: ${message}`);
    await captureFailureQuietly(evidence, page);
  } finally {
    await closeContextQuietly(context, evidence);
  }
  if (evidence.observed.pageErrors.length > 0 || evidence.observed.consoleErrors.length > 0) {
    status = "FAIL";
    evidence.notes.push(
      `Runtime errors observed: ${evidence.observed.pageErrors.length} pageErrors, ${evidence.observed.consoleErrors.length} consoleErrors.`,
    );
  }
  if (target.owned) evidence.writeText("server.log", target.logs());
  const summary = evidence.finalize(status, {
    scenario: scenario.name,
    url: target.url,
    engine: args.engine,
    viewport: `${effectiveViewport.width}x${effectiveViewport.height}`,
    scheme: args.scheme,
  });
  console.log(summary);
  return status === "PASS";
}

async function main(): Promise<void> {
  let args: ParsedArgs;
  try {
    args = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "USAGE") {
      console.log(CLI_USAGE);
      return;
    }
    console.error(`${message}\n\n${CLI_USAGE}`);
    process.exit(2);
  }

  if (args.verb === "list") {
    for (const scenario of SCENARIOS) {
      const mode = scenario.readOnly ? "read-only" : "interactive";
      console.log(`${scenario.name.padEnd(30)} [${mode}] ${scenario.description}`);
    }
    return;
  }

  const controller = new AbortController();
  let targetPromise: Promise<PreviewServerHandle> | undefined;
  let browserPromise: Promise<Browser> | undefined;
  let cleanupPromise: Promise<void> | undefined;

  const cleanup = (): Promise<void> => {
    controller.abort();
    cleanupPromise ??= (async () => {
      const [resolvedBrowser, resolvedTarget] = await Promise.allSettled([
        browserPromise ?? Promise.resolve(undefined),
        targetPromise ?? Promise.resolve(undefined),
      ]);
      const activeBrowser = resolvedBrowser.status === "fulfilled" ? resolvedBrowser.value : undefined;
      const activeTarget = resolvedTarget.status === "fulfilled" ? resolvedTarget.value : undefined;
      await Promise.allSettled([
        activeBrowser ? activeBrowser.close() : Promise.resolve(),
        activeTarget ? activeTarget.stop() : Promise.resolve(),
      ]);
    })();
    return cleanupPromise;
  };

  let exiting = false;
  const onSignal = (signal: NodeJS.Signals) => {
    const code = signal === "SIGINT" ? 130 : 143;
    if (exiting) return;
    exiting = true;
    void cleanup().finally(() => process.exit(code));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    targetPromise = resolveTarget(args, controller.signal);
    const target = await targetPromise;
    browserPromise = pickBrowserType(args.engine).launch({ headless: !args.headed });
    const browser = await browserPromise;
    const ok =
      args.verb === "look" ? await runLook(args, browser, target) : await runScenario(args, browser, target);
    if (!ok) process.exitCode = 1;
  } finally {
    await cleanup();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

await main();
