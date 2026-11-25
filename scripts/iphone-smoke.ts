// The basic flow on iPhone Safari, in the iOS Simulator on a Mac: open the landing page, start a
// workspace, run `bun --version` in the shell, write a file, reload, and find the file again.
// Drives Safari through safaridriver (WebDriver), so it needs nothing installed beyond Xcode.
//
//   bun scripts/iphone-smoke.ts --base-url https://sprockt.dev
//   bun scripts/iphone-smoke.ts --serve dist          # serves a build on 127.0.0.1 first
//
// Options: --udid <simulator> (default: the shared C4D2 iPhone simulator), --driver-port <n>,
// --port <n> (for --serve), --out <dir> (screenshots and result.json). Run it on the Mac through
// the Mac queue (machine-fleet skill) with --priority gate. Exit code 0 means every step passed.
import { spawn, type Subprocess } from "bun";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const C4D2 = "C4D2FFD4-A0D2-4608-B180-35854521B830";
/** A hang cap per step, not a speed target: the first `bun` downloads and compiles the guest. */
const STEP_LIMIT_MS = 240_000;
/** WebDriver's Enter key. */
const ENTER = String.fromCodePoint(0xe007);
const ISOLATION = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
};

interface Step {
  readonly name: string;
  readonly ok: boolean;
  readonly ms: number;
  readonly detail?: string;
}

const { values } = parseArgs({
  options: {
    "base-url": { type: "string" },
    serve: { type: "string" },
    port: { type: "string", default: "4780" },
    udid: { type: "string", default: C4D2 },
    "driver-port": { type: "string", default: "4781" },
    out: { type: "string", default: "iphone-smoke" },
  },
});

/** A static server for a build, with the isolation headers SharedArrayBuffer needs. */
function serveBuild(directory: string, port: number) {
  const root = resolve(directory);
  return Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = decodeURIComponent(new URL(request.url).pathname);
      const file = Bun.file(join(root, path));
      const found = !path.endsWith("/") && !path.includes("..") && (await file.exists());
      // Deep links get the app, like the deployed Worker's single-page fallback.
      const body = found ? file : Bun.file(join(root, "index.html"));
      return new Response(body, { headers: ISOLATION });
    },
  });
}

class WebDriver {
  private constructor(
    private readonly base: string,
    private readonly session: string,
  ) {}

  static async start(driverUrl: string, udid: string): Promise<WebDriver> {
    const capabilities = {
      platformName: "iOS",
      browserName: "Safari",
      "safari:useSimulator": true,
      "safari:deviceUDID": udid,
    };
    const response = await fetch(`${driverUrl}/session`, {
      method: "POST",
      body: JSON.stringify({ capabilities: { alwaysMatch: capabilities } }),
    });
    const body = (await response.json()) as { value: { sessionId?: string; message?: string } };
    if (!body.value.sessionId) throw new Error(`No WebDriver session: ${body.value.message}`);
    return new WebDriver(driverUrl, body.value.sessionId);
  }

  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.base}/session/${this.session}${path}`, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = (await response.json()) as { value: T & { error?: string; message?: string } };
    if (!response.ok) throw new Error(`${method} ${path}: ${result.value.message ?? response.status}`);
    return result.value;
  }

  navigate = (url: string) => this.call("POST", "/url", { url });
  url = () => this.call<string>("GET", "/url");
  script = <T>(source: string) => this.call<T>("POST", "/execute/sync", { script: source, args: [] });
  screenshot = () => this.call<string>("GET", "/screenshot");
  end = () => fetch(`${this.base}/session/${this.session}`, { method: "DELETE" });

  /**
   * Clicks from inside the page. safaridriver's element click on the iOS Simulator lands as a
   * long press that selects the button's text instead of activating it.
   */
  async click(selector: string): Promise<void> {
    const clicked = await this.script<boolean>(
      `const target = document.querySelector(${JSON.stringify(selector)}); target?.click(); return Boolean(target);`,
    );
    if (!clicked) throw new Error(`Nothing matches ${selector}`);
  }

  /** Types into whatever has focus, as key presses (the terminal's input is not a visible field). */
  async type(text: string): Promise<void> {
    const keys = Array.from(text).flatMap((value) => [
      { type: "keyDown", value },
      { type: "keyUp", value },
    ]);
    await this.call("POST", "/actions", { actions: [{ type: "key", id: "keyboard", actions: keys }] });
    await this.call("DELETE", "/actions");
  }

  /** Polls a page expression until it returns true. */
  async until(expression: string, what: string): Promise<void> {
    const deadline = Date.now() + STEP_LIMIT_MS;
    while (Date.now() < deadline) {
      // oxlint-disable-next-line no-await-in-loop
      if (await this.script<boolean>(`return Boolean(${expression});`).catch(() => false)) return;
      // oxlint-disable-next-line no-await-in-loop
      await Bun.sleep(500);
    }
    throw new Error(`Timed out waiting for ${what}`);
  }
}

const testId = (id: string) => `document.querySelector('[data-testid="${id}"]')`;
const textOf = (id: string) => `${testId(id)}?.textContent`;
const terminalHas = (pattern: string) =>
  `(globalThis.sprockt?.terminalLines() ?? []).some((line) => ${pattern}.test(line))`;

async function runInTerminal(driver: WebDriver, command: string): Promise<void> {
  await driver.until(`${textOf("terminal-state")} === "ready"`, "the shell");
  await driver.click(".terminal-host");
  await driver.type(command + ENTER);
}

function smokeSteps(driver: WebDriver, baseUrl: string) {
  return [
    {
      name: "landing page opens",
      run: async () => {
        await driver.navigate(baseUrl);
        await driver.until(testId("new-workspace"), "the landing page");
      },
    },
    {
      name: "a new workspace boots, cross-origin isolated",
      run: async () => {
        await driver.click('[data-testid="new-workspace"]');
        await driver.until(`/\\/w\\/[a-z0-9]+$/.test(location.pathname)`, "the workspace URL");
        await driver.until(`${textOf("terminal-state")} === "ready"`, "the shell");
        if (!(await driver.script<boolean>("return crossOriginIsolated;")))
          throw new Error("the page is not cross-origin isolated");
      },
    },
    {
      name: "bun --version runs in the shell",
      run: async () => {
        await runInTerminal(driver, "bun --version");
        await driver.until(terminalHas("/^\\d+\\.\\d+\\.\\d+/"), "a Bun version");
      },
    },
    {
      name: "a file written in the shell survives a reload",
      run: async () => {
        await runInTerminal(driver, "echo kept-across-reload > proof.txt");
        await driver.until(`${textOf("file-tree")}?.includes("proof.txt")`, "proof.txt");
        await driver.until(`${textOf("save-state")} === "saved"`, "the save");
        await driver.script("location.reload(); return true;");
        await driver.until(`${textOf("file-tree")}?.includes("proof.txt")`, "proof.txt after the reload");
        await runInTerminal(driver, "cat proof.txt");
        await driver.until(terminalHas("/^kept-across-reload$/"), "the file's text");
      },
    },
  ];
}

async function saveScreenshot(driver: WebDriver, path: string): Promise<void> {
  const png = await driver.screenshot().catch(() => undefined);
  if (png) await Bun.write(path, Buffer.from(png, "base64"));
}

async function runSmoke(driver: WebDriver, baseUrl: string, out: string): Promise<Step[]> {
  const steps: Step[] = [];
  for (const [index, step] of smokeSteps(driver, baseUrl).entries()) {
    const start = performance.now();
    // Each step needs the one before it.
    // oxlint-disable-next-line no-await-in-loop
    const failure = await step.run().then(
      () => undefined,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    const ms = Math.round(performance.now() - start);
    steps.push({ name: step.name, ok: failure === undefined, ms, detail: failure });
    console.log(`${failure ? "FAIL" : "pass"} ${step.name} (${ms} ms)${failure ? `: ${failure}` : ""}`);
    // oxlint-disable-next-line no-await-in-loop
    await saveScreenshot(driver, join(out, `${index + 1}.png`));
    if (failure) break;
  }
  return steps;
}

async function startDriver(port: number): Promise<Subprocess> {
  const driver = spawn(["safaridriver", "-p", String(port)], { stdout: "ignore", stderr: "inherit" });
  for (let attempt = 0; attempt < 50; attempt++) {
    // oxlint-disable-next-line no-await-in-loop
    const ready = await fetch(`http://127.0.0.1:${port}/status`).then(
      (r) => r.ok,
      () => false,
    );
    if (ready) return driver;
    // oxlint-disable-next-line no-await-in-loop
    await Bun.sleep(200);
  }
  driver.kill();
  throw new Error("safaridriver did not start");
}

async function main(): Promise<number> {
  const out = resolve(values.out!);
  await mkdir(out, { recursive: true });
  const server = values.serve ? serveBuild(values.serve, Number(values.port)) : undefined;
  const baseUrl = values["base-url"] ?? (server ? `http://127.0.0.1:${server.port}/` : undefined);
  if (!baseUrl) throw new Error("Pass --base-url <url> or --serve <build directory>");

  const driverPort = Number(values["driver-port"]);
  const driverProcess = await startDriver(driverPort);
  let driver: WebDriver | undefined;
  try {
    driver = await WebDriver.start(`http://127.0.0.1:${driverPort}`, values.udid!);
    const steps = await runSmoke(driver, baseUrl, out);
    const passed = steps.length === smokeSteps(driver, baseUrl).length && steps.every((s) => s.ok);
    await Bun.write(
      join(out, "result.json"),
      JSON.stringify({ baseUrl, udid: values.udid, passed, steps }, null, 2),
    );
    console.log(passed ? "iPhone smoke passed" : "iPhone smoke failed");
    return passed ? 0 : 1;
  } finally {
    await driver?.end().catch(() => {});
    driverProcess.kill();
    await server?.stop(true);
  }
}

process.exit(await main());
