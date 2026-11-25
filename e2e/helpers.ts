import { expect, test as base, type Page } from "@playwright/test";

/**
 * Where the workbench stood when a test failed: a test that times out while waiting says
 * nothing about why, and "still booting", "boot failed" and "open elsewhere" look the same.
 */
async function workbenchState(page: Page): Promise<string> {
  const read = page.evaluate(() => {
    const parts = [
      `path=${location.pathname}`,
      `stage=${document.querySelector("[data-testid=workbench]")?.getAttribute("data-stage")}`,
      `workspace=${globalThis.sprockt?.workspace !== undefined}`,
      `terminal=${document.querySelector("[data-testid=terminal-state]")?.textContent}`,
      `boot-error=${document.querySelector("[data-testid=boot-error]")?.textContent}`,
      `asks=${document.querySelector("[data-testid=workspace-busy]") !== null}`,
    ];
    return parts.join(" ");
  });
  const silent = new Promise<string>((resolve) => setTimeout(resolve, 5000, "the page did not answer"));
  return Promise.race([read, silent]).catch((error: Error) => `the page could not be read: ${error.message}`);
}

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
      if (testInfo.status === testInfo.expectedStatus) return;
      console.error(`[${testInfo.project.name}] ${testInfo.title}: ${await workbenchState(page)}`);
      if (errors.length === 0) return;
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

/** Opens a file from the explorer and waits until the editor shows it. */
export async function openFile(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name, exact: true }).click();
  await expect(page.getByTestId("editor-file")).toHaveText(name);
}

/** Types at the end of the document in the editor. */
export async function typeInEditor(page: Page, text: string): Promise<void> {
  await page.getByTestId("editor").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(text);
}

/** Writes a project file through the app's file service, as a pane would. */
export async function writeFile(page: Page, path: string, text: string): Promise<void> {
  // The session exists only once the workspace has booted; writing before that wrote nothing.
  await expect.poll(() => page.evaluate(() => globalThis.sprockt?.workspace !== undefined)).toBe(true);
  await page.evaluate(([file, content]) => globalThis.sprockt!.workspace!.files.write(file, content), [
    path,
    text,
  ] as const);
}

/** Waits for the shell prompt, then types a command and presses Enter. */
export async function runInTerminal(page: Page, command: string): Promise<void> {
  await expect(page.getByTestId("terminal-state")).toHaveText("ready");
  await page.locator(".terminal-host").click();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}
