import type { Browser, Page } from "@playwright/test";
import type { ParsedArgs } from "../args.ts";
import type { EvidenceSession } from "../evidence.ts";

export interface ScenarioContext {
  readonly browser: Browser;
  readonly page: Page;
  readonly baseUrl: string;
  readonly args: ParsedArgs;
  readonly evidence: EvidenceSession;
}

export interface AgentScenario {
  readonly name: string;
  readonly description: string;
  readonly readOnly: boolean;
  readonly defaultViewport?: "desktop" | "phone";
  readonly run: (ctx: ScenarioContext) => Promise<void>;
}

export function assertCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export async function waitForWorkbenchReady(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForSelector(`${SELECTORS_WORKBENCH_READY}`, { timeout: timeoutMs });
}

const SELECTORS_WORKBENCH_READY = '[data-testid="workbench"][data-stage="ready"]';
