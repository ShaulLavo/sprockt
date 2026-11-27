import type { Page } from "@playwright/test";
import { editorText, expect, newWorkspace, runInTerminal, test, withoutAutosave } from "./helpers";

/** Opens a new workspace and writes `files` into it through the page's FileService. */
async function workspaceWith(page: Page, files: Record<string, string>): Promise<string> {
  const id = await newWorkspace(page);
  await expect(page.getByTestId("boot-stage")).toHaveText("Ready");
  await page.evaluate(async (set) => {
    const workspace = globalThis.sprockt?.workspace;
    if (!workspace) throw new Error("No workspace on the debug handle");
    await workspace.files.writeMany(set);
  }, files);
  const tree = page.getByTestId("file-tree");
  await Promise.all(
    Object.keys(files).map((path) => expect(tree).toContainText(path.slice(path.lastIndexOf("/") + 1))),
  );
  return id;
}

/**
 * Presses a shortcut with `Mod` resolved the way the page resolves it. Playwright's WebKit
 * presents a Mac user agent even on Linux, so the app expects Meta there, not Control.
 */
async function press(page: Page, shortcut: string): Promise<void> {
  const mac = await page.evaluate(() => /mac/i.test(`${navigator.platform} ${navigator.userAgent}`));
  await page.keyboard.press(shortcut.replace("Mod+", mac ? "Meta+" : "Control+"));
}

/** Puts the caret at the end of the document: Cmd+Down on a Mac, Ctrl+End elsewhere. */
async function caretToEnd(page: Page): Promise<void> {
  const mac = await page.evaluate(() => /mac/i.test(`${navigator.platform} ${navigator.userAgent}`));
  await page.keyboard.press(mac ? "Meta+ArrowDown" : "Control+End");
}

const tab = (page: Page, path: string) => page.locator(`[data-testid="editor-tab"][data-path="${path}"]`);
const caret = (page: Page) => page.evaluate(() => globalThis.sprockt?.editorCaret?.());

async function openFromTree(page: Page, name: string): Promise<void> {
  await page.getByTestId("file-tree").getByRole("treeitem", { name, exact: true }).click();
}

test("two files open in tabs, an edit is saved with the shortcut and survives a reload", async ({ page }) => {
  await withoutAutosave(page);
  await workspaceWith(page, { "notes.txt": "first file\n", "todo.md": "# Todo\n" });

  await openFromTree(page, "notes.txt");
  await openFromTree(page, "todo.md");
  await expect(page.getByTestId("editor-tab")).toHaveCount(2);
  await expect(tab(page, "todo.md")).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => editorText(page)).toBe("# Todo\n");

  await tab(page, "notes.txt").click();
  await expect(tab(page, "notes.txt")).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => editorText(page)).toBe("first file\n");

  await page.getByTestId("editor").click();
  await caretToEnd(page);
  await page.keyboard.type("saved line");
  await expect(tab(page, "notes.txt")).toHaveClass(/is-dirty/);
  await press(page, "Mod+s");
  await expect(tab(page, "notes.txt")).not.toHaveClass(/is-dirty/);
  await expect(page.getByTestId("save-state")).toHaveText("saved");

  await page.reload();
  await expect(page.getByTestId("editor-tab")).toHaveCount(2);
  await expect(tab(page, "notes.txt")).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => editorText(page)).toBe("first file\nsaved line");
});

test("tabs reorder by dragging and close with a middle click", async ({ page }) => {
  await workspaceWith(page, { "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" });
  await openFromTree(page, "a.txt");
  await openFromTree(page, "b.txt");
  await openFromTree(page, "c.txt");
  const order = () =>
    page.getByTestId("editor-tab").evaluateAll((elements) => elements.map((element) => element.dataset.path));
  await expect.poll(order).toEqual(["a.txt", "b.txt", "c.txt"]);

  await tab(page, "a.txt").dragTo(tab(page, "c.txt"), { targetPosition: { x: 60, y: 10 } });
  await expect.poll(order).toEqual(["b.txt", "c.txt", "a.txt"]);

  await tab(page, "b.txt").click({ button: "middle" });
  await expect.poll(order).toEqual(["c.txt", "a.txt"]);
});

test("quick open finds a file by a fuzzy name and opens it", async ({ page }) => {
  await workspaceWith(page, {
    "src/components/CounterButton.tsx": "export const CounterButton = () => null;\n",
    "src/main.ts": "console.log('main');\n",
  });

  await press(page, "Mod+p");
  await expect(page.getByTestId("quick-open")).toBeVisible();
  await page.keyboard.type("cntbtn");
  await expect(page.getByTestId("quick-open-result").first()).toHaveAttribute(
    "data-path",
    "src/components/CounterButton.tsx",
  );
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("quick-open")).toHaveCount(0);
  await expect(tab(page, "src/components/CounterButton.tsx")).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => editorText(page)).toBe("export const CounterButton = () => null;\n");
});

test("project search finds text and opens the file at the matching line", async ({ page }) => {
  await workspaceWith(page, {
    "src/one.ts": "const a = 1;\n",
    "src/two.ts": "// header\n\nexport const needleValue = 2;\n",
  });

  await press(page, "Mod+Shift+f");
  await expect(page.getByTestId("search-panel")).toBeVisible();
  await page.getByTestId("search-input").fill("needleValue");
  await expect(page.getByTestId("search-file")).toHaveCount(1);
  await expect(page.getByTestId("search-file")).toHaveAttribute("data-path", "src/two.ts");

  await page.getByTestId("search-result").first().click();
  await expect(tab(page, "src/two.ts")).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => caret(page)).toEqual({ path: "src/two.ts", line: 3, column: 14 });
});

test("a shell edit reloads a clean buffer and puts a conflict on a dirty one", async ({ page }) => {
  await withoutAutosave(page);
  await workspaceWith(page, { "shell.txt": "before\n", "mine.txt": "base\n" });

  await openFromTree(page, "shell.txt");
  await expect.poll(() => editorText(page)).toBe("before\n");
  await runInTerminal(page, "echo after-the-shell > shell.txt");
  await expect.poll(() => editorText(page)).toBe("after-the-shell\n");
  await expect(tab(page, "shell.txt")).not.toHaveClass(/is-dirty/);

  await openFromTree(page, "mine.txt");
  await page.getByTestId("editor").click();
  await caretToEnd(page);
  await page.keyboard.type("unsaved");
  await runInTerminal(page, "echo from-outside > mine.txt");
  await expect(page.getByTestId("editor-conflict")).toBeVisible();
  await tab(page, "mine.txt").click();
  await expect.poll(() => editorText(page)).toBe("base\nunsaved");

  await page.getByRole("button", { name: "Reload from disk" }).click();
  await expect(page.getByTestId("editor-conflict")).toHaveCount(0);
  await expect.poll(() => editorText(page)).toBe("from-outside\n");
  await expect(tab(page, "mine.txt")).not.toHaveClass(/is-dirty/);
});

test("a plugin provider registered through the mount hook mounts on the live editor", async ({ page }) => {
  await workspaceWith(page, { "plugin.txt": "hello\n" });
  await openFromTree(page, "plugin.txt");
  const mounted = await page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const register = globalThis.sprockt?.registerEditorPlugins;
        if (!register) throw new Error("No plugin hook on the debug handle");
        register(({ rootUri }) => [
          {
            name: "e2e.mount-probe",
            activate: () => {
              resolve(rootUri);
              return undefined;
            },
          },
        ]);
      }),
  );
  expect(mounted).toBe("file:///workspace");
});

const treeRow = (page: Page, path: string) => page.locator(`[data-wb-tree-row][data-path="${path}"]`);
const read = (page: Page, path: string) =>
  page.evaluate((file) => globalThis.sprockt?.workspace?.files.read(file), path);

test("folders moved and deleted from the terminal leave open files open, marked deleted, unsaved text kept", async ({
  page,
}) => {
  await withoutAutosave(page);
  await workspaceWith(page, { "docs/a.txt": "hello\n", "notes/b.txt": "bee\n" });
  await treeRow(page, "docs/a.txt").click();
  await expect(tab(page, "docs/a.txt")).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => editorText(page)).toBe("hello\n");
  await page.getByTestId("editor").click();
  await caretToEnd(page);
  await page.keyboard.type("unsaved");
  await expect(tab(page, "docs/a.txt")).toHaveClass(/is-dirty/);

  // The shell gives no move information: the file is gone from its path, so the tab says so.
  await runInTerminal(page, "mv docs moved");
  await expect(tab(page, "docs/a.txt")).toHaveClass(/is-missing/);
  await expect(tab(page, "docs/a.txt")).toHaveClass(/is-dirty/);
  expect(await editorText(page)).toBe("hello\nunsaved");
  expect(await read(page, "moved/a.txt")).toBe("hello\n");

  // A clean file inside a deleted folder stays open too, marked, and can be read until closed.
  await treeRow(page, "notes/b.txt").click();
  await expect.poll(() => editorText(page)).toBe("bee\n");
  await runInTerminal(page, "rm -r notes");
  await expect(tab(page, "notes/b.txt")).toHaveClass(/is-missing/);

  // Saving the deleted file writes it again, with the unsaved text.
  await tab(page, "docs/a.txt").click();
  await press(page, "Mod+s");
  await expect(tab(page, "docs/a.txt")).not.toHaveClass(/is-dirty/);
  await expect(tab(page, "docs/a.txt")).not.toHaveClass(/is-missing/);
  expect(await read(page, "docs/a.txt")).toBe("hello\nunsaved");

  // FileService measures files without reading them; search uses that to skip big ones.
  const sizes = await page.evaluate(async () => {
    const files = globalThis.sprockt?.workspace?.files;
    return [await files?.size("docs/a.txt"), await files?.size("notes/b.txt"), await files?.size("moved")];
  });
  expect(sizes).toEqual([13, undefined, undefined]);
});

test("the status bar shows the caret position and the language of the open file", async ({ page }) => {
  await workspaceWith(page, { "src/main.ts": "const a = 1;\nconst b = 2;\n" });
  await treeRow(page, "src/main.ts").click();
  await expect.poll(() => editorText(page)).toBe("const a = 1;\nconst b = 2;\n");
  await press(page, "Mod+p");
  await page.keyboard.type("main.ts:2:7");
  await page.keyboard.press("Enter");
  const status = page.getByTestId("status-bar");
  await expect(status).toContainText("Ln 2, Col 7");
  await expect(status).toContainText("TypeScript");
});
