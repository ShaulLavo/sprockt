import type { Page } from "@playwright/test";
import { editorText, expect, newWorkspace, openFile, test, writeFile } from "./helpers";

// A phone has no Ctrl+S: edits are saved by themselves a moment after typing stops, and the ⋯ menu
// and quick open offer Save. No test here presses a key combination.

const fileText = (page: Page, path: string) =>
  page.evaluate((file) => globalThis.sprockt?.workspace?.files.read(file), path);

const pane = (page: Page, name: string) =>
  page.getByTestId("pane-switcher").getByRole("button", { name, exact: true });

/** Taps into the editor and enters text the way a phone keyboard does: no key presses. */
async function enterOnPhone(page: Page, text: string): Promise<void> {
  await page.getByTestId("editor").tap();
  await page.keyboard.insertText(text);
}

async function menuItem(page: Page, name: string) {
  await page.getByTestId("phone-menu").tap();
  return page.getByRole("menuitem", { name, exact: true });
}

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("an edit made by touch is saved without any shortcut and survives a reload", async ({ page }) => {
    await newWorkspace(page);
    await expect(page.getByTestId("terminal-state")).toHaveText("ready");
    await writeFile(page, "notes.txt", "first line");
    await openFile(page, "notes.txt");
    await expect.poll(() => editorText(page)).toBe("first line");

    await enterOnPhone(page, " typed on the phone");
    await expect.poll(() => editorText(page)).toContain("typed on the phone");
    const typed = await editorText(page);
    // Saved by itself: the unsaved dot goes, the disk has the text, and storage holds it.
    await expect(page.getByTestId("editor-dirty")).toHaveCount(0);
    await expect.poll(() => fileText(page, "notes.txt")).toBe(typed);
    await expect(page.getByTestId("save-state")).toHaveText("saved");

    await page.reload();
    await expect(page.getByTestId("terminal-state")).toHaveText("ready");
    await expect.poll(() => fileText(page, "notes.txt")).toBe(typed);
    await expect.poll(() => editorText(page)).toBe(typed);
  });

  test("with autosave off, the menu's Save writes the file, and the setting sticks", async ({ page }) => {
    await newWorkspace(page);
    await expect(page.getByTestId("terminal-state")).toHaveText("ready");
    await writeFile(page, "notes.txt", "kept");
    await openFile(page, "notes.txt");
    await expect.poll(() => editorText(page)).toBe("kept");

    await (await menuItem(page, "Turn off autosave")).tap();
    await enterOnPhone(page, " by hand");
    await expect(page.getByTestId("editor-dirty")).toBeVisible();
    // Off means off: a pause longer than autosave's wait writes nothing.
    await page.waitForTimeout(2000);
    expect(await fileText(page, "notes.txt")).toBe("kept");
    // The menu button carries a dot while something is unsaved.
    await expect(page.locator(".wb-menu-dot")).toBeVisible();

    await (await menuItem(page, "Save")).tap();
    await expect(page.getByTestId("editor-dirty")).toHaveCount(0);
    const typed = await editorText(page);
    await expect.poll(() => fileText(page, "notes.txt")).toBe(typed);
    await expect(page.locator(".wb-menu-dot")).toHaveCount(0);

    // The setting is this browser's, kept across a reload, and turns back on from the same menu.
    await page.reload();
    await expect(page.getByTestId("terminal-state")).toHaveText("ready");
    await (await menuItem(page, "Turn on autosave")).tap();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(await menuItem(page, "Turn off autosave")).toBeVisible();
  });

  test("an edit by touch reaches a running dev server's preview", async ({ page, browserName }) => {
    // Bun's browser engine traps in Playwright's WebKit (ARCHITECTURE.md "Known gaps").
    test.fixme(browserName === "webkit", "Bun's browser engine traps in WebKit");
    await newWorkspace(page);
    await expect(page.getByTestId("terminal-state")).toHaveText("ready");
    // A server that reads its heading from a page file when it starts; the task runs it again
    // after a person edits a page.
    const server = [
      'import { readFileSync } from "node:fs";',
      'const title = readFileSync("title.html", "utf8").trim();',
      'const html = "<!doctype html><html><head><title>T</title></head><body><h1>" + title + "</h1></body></html>";',
      'Bun.serve({ port: 3000, fetch: () => new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }) });',
    ].join("\n");
    await writeFile(page, "title.html", "Before");
    await writeFile(page, "server.ts", server);

    await pane(page, "Preview").tap();
    await page.getByTestId("preview-start").tap();
    const heading = page.frameLocator("[data-testid=preview-frame]").getByRole("heading");
    await expect(heading).toHaveText("Before");

    await pane(page, "Files").tap();
    await openFile(page, "title.html");
    await expect.poll(() => editorText(page)).toBe("Before");
    await enterOnPhone(page, " and after");
    await expect.poll(() => editorText(page)).toContain("and after");
    const typed = (await editorText(page)) ?? "";
    await expect.poll(() => fileText(page, "title.html")).toBe(typed);

    await pane(page, "Preview").tap();
    await expect(heading).toHaveText(typed.trim());
  });
});

test("quick open runs Save all, and a matching command shows above the files", async ({ page }) => {
  await newWorkspace(page);
  await expect(page.getByTestId("terminal-state")).toHaveText("ready");
  await writeFile(page, "a.txt", "A");
  await openFile(page, "a.txt");
  await expect.poll(() => editorText(page)).toBe("A");
  await page.evaluate(() => localStorage.setItem("sprockt:editor-autosave", "off"));
  await page.reload();
  await expect(page.getByTestId("terminal-state")).toHaveText("ready");
  await expect.poll(() => editorText(page)).toBe("A");
  await page.getByTestId("editor").click();
  await page.keyboard.insertText("1");
  await expect(page.getByTestId("editor-dirty")).toBeVisible();

  await page.getByRole("button", { name: "Search files and commands" }).click();
  await expect(page.getByTestId("quick-open")).toBeVisible();
  await page.keyboard.insertText("save");
  await expect(page.getByTestId("quick-open-command")).toHaveCount(2);
  await expect(page.locator("[data-testid=quick-open] li").first()).toHaveAttribute("data-command", "save");
  await page.locator('[data-command="save-all"]').click();
  await expect(page.getByTestId("quick-open")).toHaveCount(0);
  await expect(page.getByTestId("editor-dirty")).toHaveCount(0);
  const typed = await editorText(page);
  await expect.poll(() => fileText(page, "a.txt")).toBe(typed);
});
