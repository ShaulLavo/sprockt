import { resolve } from "node:path";
import { chromium, firefox, webkit, type Browser, type BrowserType } from "@playwright/test";
import {
  CLI_USAGE,
  parseCliArgs,
  VIEWPORT_PRESETS,
  type BrowserEngine,
  type ParsedArgs,
  type ViewportSpec,
} from "./args.ts";
import { createEvidenceSession } from "./evidence.ts";
import { findScenario, SCENARIOS } from "./scenarios/index.ts";
import { startThrowawayPreviewServer, type PreviewServerHandle } from "./server.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

function pickBrowserType(engine: BrowserEngine): BrowserType {
  if (engine === "webkit") return webkit;
  if (engine === "firefox") return firefox;
  return chromium;
}

function isProductionUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "sprockt.dev" || parsed.hostname.endsWith(".sprockt.dev");
  } catch {
    return false;
  }
}

async function resolveTarget(args: ParsedArgs): Promise<PreviewServerHandle> {
  if (args.url) {
    return {
      url: args.url,
      port: 0,
      owned: false,
      logs: () => "",
      stop: async () => {},
    };
  }
  return startThrowawayPreviewServer(REPO_ROOT);
}

function collectDoctorProblems(
  layout: {
    readonly crossOriginIsolated: boolean;
    readonly overflowX: number;
    readonly visibleAlerts: readonly string[];
    readonly brokenImages: readonly string[];
  },
  observed: { readonly pageErrors: readonly string[]; readonly consoleErrors: readonly string[] },
): string[] {
  const problems: string[] = [];
  if (!layout.crossOriginIsolated) problems.push("crossOriginIsolated is false (missing COOP/COEP headers)");
  if (layout.overflowX > 0) problems.push(`horizontal overflow detected (${layout.overflowX}px)`);
  if (layout.visibleAlerts.length > 0) problems.push(`visible alert(s): ${layout.visibleAlerts.join("; ")}`);
  if (layout.brokenImages.length > 0) problems.push(`broken image(s): ${layout.brokenImages.join(", ")}`);
  if (observed.pageErrors.length > 0) problems.push(`${observed.pageErrors.length} pageerror(s)`);
  if (observed.consoleErrors.length > 0) problems.push(`${observed.consoleErrors.length} console error(s)`);
  return problems;
}

async function runLook(args: ParsedArgs, browser: Browser, target: PreviewServerHandle): Promise<boolean> {
  const label = `${args.doctor ? "doctor-" : ""}${args.viewport.label}-${args.scheme}-${args.engine}`;
  const evidence = createEvidenceSession("look", label, args.evidenceRoot);
  const context = await browser.newContext({
    viewport: { width: args.viewport.width, height: args.viewport.height },
    isMobile: args.viewport.isMobile,
    hasTouch: args.viewport.hasTouch,
    colorScheme: args.scheme,
  });
  let status: "PASS" | "FAIL" = "PASS";
  try {
    const page = await context.newPage();
    evidence.attach(page);
    await page.goto(target.url, { waitUntil: "networkidle", timeout: args.timeoutMs });
    await page.evaluate(() => document.fonts.ready);
    const layout = await evidence.snapshotLayout(page);
    evidence.writeJson("layout.json", layout);
    await evidence.capture(page, "viewport", { selector: args.selector });
    if (!args.selector) {
      await evidence.capture(page, "full-page", { fullPage: true });
    }
    if (args.doctor) {
      const problems = collectDoctorProblems(layout, evidence.observed);
      if (problems.length > 0) {
        status = "FAIL";
        evidence.notes.push(...problems.map((item) => `Doctor failure: ${item}`));
      } else {
        evidence.notes.push("Doctor healthy: COOP/COEP active, 0 overflow, 0 alerts, 0 page/console errors.");
      }
    }
    if (target.owned) evidence.writeText("server.log", target.logs());
    const summary = evidence.finalize(status, {
      url: target.url,
      engine: args.engine,
      viewport: `${args.viewport.width}x${args.viewport.height}`,
      scheme: args.scheme,
      crossOriginIsolated: layout.crossOriginIsolated,
      overflowX: layout.overflowX,
    });
    console.log(summary);
    return status === "PASS";
  } finally {
    await context.close();
  }
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
  if (args.url && isProductionUrl(args.url) && !scenario.readOnly) {
    throw new Error(`Refusing writing scenario "${scenario.name}" against production URL ${args.url}.`);
  }
  const effectiveViewport: ViewportSpec =
    args.viewport === VIEWPORT_PRESETS.desktop && scenario.defaultViewport === "phone"
      ? VIEWPORT_PRESETS.phone
      : args.viewport;
  const evidence = createEvidenceSession("scenario", `${scenario.name}-${args.engine}`, args.evidenceRoot);
  const context = await browser.newContext({
    viewport: { width: effectiveViewport.width, height: effectiveViewport.height },
    isMobile: effectiveViewport.isMobile,
    hasTouch: effectiveViewport.hasTouch,
    colorScheme: args.scheme,
  });
  let status: "PASS" | "FAIL" = "PASS";
  try {
    const page = await context.newPage();
    evidence.attach(page);
    try {
      await scenario.run({
        browser,
        page,
        baseUrl: target.url,
        args: { ...args, viewport: effectiveViewport },
        evidence,
      });
    } catch (error) {
      status = "FAIL";
      const message = error instanceof Error ? error.message : String(error);
      evidence.notes.push(`Scenario failed: ${message}`);
      await evidence.capture(page, "failure-state").catch(() => {});
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
  } finally {
    await context.close();
  }
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

  const target = await resolveTarget(args);
  let browser: Browser | undefined;
  try {
    browser = await pickBrowserType(args.engine).launch({ headless: !args.headed });
    const ok =
      args.verb === "look" ? await runLook(args, browser, target) : await runScenario(args, browser, target);
    if (!ok) process.exitCode = 1;
  } finally {
    await browser?.close();
    await target.stop();
  }
}

await main();
