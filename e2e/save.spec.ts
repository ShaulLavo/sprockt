import {
  editorText,
  expect,
  newWorkspace,
  openFile,
  runInTerminal,
  terminalText,
  test,
  typeInEditor,
  writeFile,
} from "./helpers";

test("opening a file is not an edit; typing is, and saving writes it", async ({ page }) => {
  await newWorkspace(page);
  await expect(page.getByTestId("terminal-state")).toHaveText("ready");
  await writeFile(page, "notes.txt", "first line\n");
  await openFile(page, "notes.txt");
  await expect.poll(() => editorText(page)).toBe("first line\n");
  await expect(page.getByTestId("editor-dirty")).toBeHidden();

  await typeInEditor(page, "typed");
  await expect(page.getByTestId("editor-dirty")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByTestId("editor-dirty")).toBeHidden();
  await expect(page.getByTestId("save-state")).toHaveText("saved");

  await runInTerminal(page, "cat notes.txt");
  // The typed line has no newline at its end, so the prompt follows it on the same row.
  await expect.poll(() => terminalText(page)).toMatch(/^first line\ntyped/m);
});

test("unsaved text survives switching to another file and back", async ({ page }) => {
  await newWorkspace(page);
  await expect(page.getByTestId("terminal-state")).toHaveText("ready");
  await writeFile(page, "a.txt", "A\n");
  await writeFile(page, "b.txt", "B\n");
  await openFile(page, "a.txt");
  await typeInEditor(page, "unsaved");

  await openFile(page, "b.txt");
  await expect.poll(() => editorText(page)).toBe("B\n");
  await expect(page.getByTestId("editor-dirty")).toBeHidden();

  await openFile(page, "a.txt");
  await expect.poll(() => editorText(page)).toBe("A\nunsaved");
  await expect(page.getByTestId("editor-dirty")).toBeVisible();

  // Saving now writes a.txt and leaves b.txt alone.
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByTestId("editor-dirty")).toBeHidden();
  await runInTerminal(page, "cat b.txt a.txt");
  await expect.poll(() => terminalText(page)).toMatch(/^B\nA\nunsaved/m);
});

test("a plugin that arrives late keeps the text on screen, the unsaved state and undo", async ({
  page,
  browserName,
}) => {
  await newWorkspace(page);
  await expect(page.getByTestId("terminal-state")).toHaveText("ready");
  await writeFile(page, "notes.txt", "first line\n");
  await openFile(page, "notes.txt");
  await typeInEditor(page, "typed before the plugin");
  await expect(page.getByTestId("editor-dirty")).toBeVisible();

  // A language server loaded after the editor opened registers its plugins now.
  const activated = await page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        globalThis.sprockt?.registerEditorPlugins(() => [{ name: "late", activate: () => resolve(true) }]);
      }),
  );
  expect(activated).toBe(true);

  expect(await editorText(page)).toBe("first line\ntyped before the plugin");
  await expect(page.getByTestId("editor-dirty")).toBeVisible();
  await page.getByTestId("editor").click();
  // Playwright's WebKit reports a Mac, so the editor expects the Mac shortcut there.
  await page.keyboard.press(browserName === "webkit" ? "Meta+z" : "Control+z");
  await expect.poll(() => editorText(page)).not.toContain("typed before the plugin");
});

test("a save does not overwrite a change the shell made since the file was opened", async ({ page }) => {
  await newWorkspace(page);
  await expect(page.getByTestId("terminal-state")).toHaveText("ready");
  await writeFile(page, "shared.txt", "original\n");
  await openFile(page, "shared.txt");
  await expect.poll(() => editorText(page)).toBe("original\n");

  await runInTerminal(page, "echo from-the-shell > shared.txt");
  await expect(page.getByTestId("save-state")).toHaveText("saved");
  await typeInEditor(page, "mine");
  await page.keyboard.press("ControlOrMeta+s");

  await expect(page.getByTestId("editor-conflict")).toBeVisible();
  await runInTerminal(page, "cat shared.txt");
  await expect.poll(() => terminalText(page)).toMatch(/^from-the-shell$/m);

  await page.getByTestId("conflict-reload").click();
  await expect(page.getByTestId("editor-conflict")).toBeHidden();
  await expect.poll(() => editorText(page)).toBe("from-the-shell\n");
  await expect(page.getByTestId("editor-dirty")).toBeHidden();
});
