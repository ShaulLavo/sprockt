import { expect, test as base, type Page } from "@playwright/test";

/**
 * Every spec imports `test` from here. When a test fails, the page's errors are attached to the
 * report, because a boot failure in a worker is otherwise invisible.
 */
export const test = base.extend<{ pageErrors: string[] }>({
  pageErrors: [
    async ({ page }, use, testInfo) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(`console: ${message.text()}`);
      });
      await use(errors);
      if (testInfo.status === testInfo.expectedStatus || errors.length === 0) return;
      await testInfo.attach("page-errors", { body: errors.join("\n"), contentType: "text/plain" });
      console.error(`[${testInfo.project.name}] page errors:\n${errors.join("\n")}`);
    },
    { auto: true },
  ],
});

export { expect };

/** Opens a new workspace from the landing page and returns its id. */
export async function newWorkspace(page: Page): Promise<string> {
  await page.goto("/");
  await page.getByTestId("new-workspace").click();
  await expect(page).toHaveURL(/\/w\/[a-z0-9]+$/);
  return new URL(page.url()).pathname.slice("/w/".length);
}

/** The text on the terminal's screen. The terminal draws on a canvas, so it is read from the app. */
export function terminalText(page: Page): Promise<string> {
  return page.evaluate(() => (globalThis.sprockt?.terminalLines() ?? []).join("\n"));
}

export function editorText(page: Page): Promise<string | undefined> {
  return page.evaluate(() => globalThis.sprockt?.editorText());
}

/** Waits for the shell prompt, then types a command and presses Enter. */
export async function runInTerminal(page: Page, command: string): Promise<void> {
  await expect(page.getByTestId("terminal-state")).toHaveText("ready");
  await page.locator(".terminal-host").click();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}
