import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConsoleMessage, Page, Request, Response } from "@playwright/test";

export interface ObservedProblems {
  readonly pageErrors: string[];
  readonly consoleErrors: string[];
  readonly consoleWarnings: string[];
  readonly failedRequests: { readonly url: string; readonly method: string; readonly reason: string }[];
  readonly badResponses: { readonly url: string; readonly status: number }[];
}

export interface LayoutSnapshot {
  readonly url: string;
  readonly title: string;
  readonly appSurface: "landing" | "workbench" | "import" | "unknown";
  readonly crossOriginIsolated: boolean;
  readonly colorScheme: string;
  readonly themeAttr: string | null;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly documentWidth: number;
  readonly overflowX: number;
  readonly visibleAlerts: string[];
  readonly brokenImages: string[];
  readonly iframes: { readonly src: string | null; readonly width: number; readonly height: number }[];
}

export interface EvidenceSession {
  readonly dir: string;
  readonly observed: ObservedProblems;
  readonly screenshots: string[];
  readonly notes: string[];
  readonly attach: (page: Page) => void;
  readonly capture: (
    page: Page,
    name: string,
    options?: { readonly fullPage?: boolean; readonly selector?: string },
  ) => Promise<string>;
  readonly snapshotLayout: (page: Page) => Promise<LayoutSnapshot>;
  readonly writeJson: (filename: string, value: unknown) => void;
  readonly writeText: (filename: string, text: string) => void;
  readonly finalize: (
    status: "PASS" | "FAIL",
    metadata: Readonly<Record<string, string | number | boolean>>,
  ) => string;
}

function sanitizeLabel(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function padTwo(n: number): string {
  return String(n).padStart(2, "0");
}

function formatStamp(date: Date): string {
  return `${date.getFullYear()}${padTwo(date.getMonth() + 1)}${padTwo(date.getDate())}-${padTwo(date.getHours())}${padTwo(date.getMinutes())}${padTwo(date.getSeconds())}`;
}

async function snapshotLayout(page: Page): Promise<LayoutSnapshot> {
  return page.evaluate(() => {
    const docEl = document.documentElement;
    const body = document.body;
    const appSurface: "landing" | "workbench" | "import" | "unknown" = document.querySelector(
      '[data-testid="landing-page"]',
    )
      ? "landing"
      : document.querySelector('[data-testid="workbench"]')
        ? "workbench"
        : document.querySelector('[data-testid="import-page"]')
          ? "import"
          : "unknown";
    const alerts = Array.from(document.querySelectorAll('[role="alert"]'))
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .map((el) => (el.textContent ?? "").trim())
      .filter(Boolean);
    const brokenImages = Array.from(document.querySelectorAll("img"))
      .filter((img) => img.complete && img.naturalWidth === 0)
      .map((img) => img.currentSrc || img.src || "(no src)");
    const iframes = Array.from(document.querySelectorAll("iframe")).map((frame) => {
      const rect = frame.getBoundingClientRect();
      return {
        src: frame.getAttribute("src"),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    });
    const documentWidth = Math.max(docEl.scrollWidth, body?.scrollWidth ?? 0);
    return {
      url: location.href,
      title: document.title,
      appSurface,
      crossOriginIsolated: Boolean(globalThis.crossOriginIsolated),
      colorScheme: getComputedStyle(docEl).colorScheme,
      themeAttr: docEl.getAttribute("data-theme"),
      viewport: { width: window.innerWidth, height: window.innerHeight },
      documentWidth,
      overflowX: Math.max(0, documentWidth - window.innerWidth),
      visibleAlerts: alerts,
      brokenImages,
      iframes,
    };
  });
}

function recordResponse(observed: ObservedProblems, res: Response): void {
  if (res.status() < 400) return;
  observed.badResponses.push({ url: res.url(), status: res.status() });
}

function recordConsole(observed: ObservedProblems, msg: ConsoleMessage): void {
  if (msg.type() === "error") observed.consoleErrors.push(msg.text());
  else if (msg.type() === "warning") observed.consoleWarnings.push(msg.text());
}

export function createEvidenceSession(verb: string, label: string, customRoot?: string): EvidenceSession {
  const root = customRoot ?? process.env.SPROCKT_EVIDENCE_ROOT ?? join(tmpdir(), "sprockt-evidence");
  mkdirSync(root, { recursive: true });
  const stamp = formatStamp(new Date());
  const prefix = join(root, `${stamp}-${sanitizeLabel(verb)}-${sanitizeLabel(label)}-`);
  const dir = mkdtempSync(prefix);

  const observed: ObservedProblems = {
    pageErrors: [],
    consoleErrors: [],
    consoleWarnings: [],
    failedRequests: [],
    badResponses: [],
  };
  const screenshots: string[] = [];
  const notes: string[] = [];

  function attach(page: Page): void {
    page.on("pageerror", (error: Error) => observed.pageErrors.push(error.message));
    page.on("console", (msg: ConsoleMessage) => recordConsole(observed, msg));
    page.on("requestfailed", (req: Request) => {
      observed.failedRequests.push({
        url: req.url(),
        method: req.method(),
        reason: req.failure()?.errorText ?? "failed",
      });
    });
    page.on("response", (res: Response) => recordResponse(observed, res));
  }

  async function capture(
    page: Page,
    name: string,
    options?: { readonly fullPage?: boolean; readonly selector?: string },
  ): Promise<string> {
    const index = String(screenshots.length + 1).padStart(2, "0");
    const filename = `${index}-${sanitizeLabel(name)}.png`;
    const filePath = join(dir, filename);
    if (options?.selector) {
      await page.locator(options.selector).first().screenshot({ path: filePath });
    } else {
      await page.screenshot({ path: filePath, fullPage: options?.fullPage ?? false });
    }
    screenshots.push(filename);
    return filePath;
  }

  function writeJson(filename: string, value: unknown): void {
    writeFileSync(join(dir, filename), `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }

  function writeText(filename: string, text: string): void {
    writeFileSync(join(dir, filename), text, "utf8");
  }

  function finalize(
    status: "PASS" | "FAIL",
    metadata: Readonly<Record<string, string | number | boolean>>,
  ): string {
    writeJson("observed.json", observed);
    const metaLines = Object.entries(metadata).map(([key, value]) => `- **${key}:** ${String(value)}`);
    const shotLines =
      screenshots.length > 0 ? screenshots.map((shot) => `- \`${join(dir, shot)}\``) : ["- (none)"];
    const noteLines = notes.length > 0 ? notes.map((line) => `- ${line}`) : ["- (none)"];
    const problemSummary = [
      `pageErrors=${observed.pageErrors.length}`,
      `consoleErrors=${observed.consoleErrors.length}`,
      `consoleWarnings=${observed.consoleWarnings.length}`,
      `failedRequests=${observed.failedRequests.length}`,
      `badResponses=${observed.badResponses.length}`,
    ].join(", ");
    const lines = [
      `# ${status} — ${verb} (${label})`,
      "",
      `- **Evidence:** \`${dir}\``,
      `- **Observed:** ${problemSummary}`,
    ]
      .concat(metaLines)
      .concat(["", "## Notes"])
      .concat(noteLines)
      .concat(["", "## Screenshots"])
      .concat(shotLines);
    const summary = `${lines.join("\n")}\n`;
    writeText("summary.md", summary);
    return summary;
  }

  return {
    dir,
    observed,
    screenshots,
    notes,
    attach,
    capture,
    snapshotLayout,
    writeJson,
    writeText,
    finalize,
  };
}
