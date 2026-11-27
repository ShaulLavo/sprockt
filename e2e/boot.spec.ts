import { editorText, expect, newWorkspace, runInTerminal, terminalText, test } from "./helpers";

test("a workspace boots, the shell runs, and files survive a reload", async ({ page }) => {
  await newWorkspace(page);
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);

  await runInTerminal(page, "echo kept-across-reload > proof.txt");
  await expect(page.getByTestId("file-tree")).toContainText("proof.txt");
  await expect(page.getByTestId("save-state")).toHaveText("saved");

  await page.reload();
  await expect(page.getByTestId("file-tree")).toContainText("proof.txt");
  await page.getByTestId("file-tree").getByRole("treeitem", { name: "proof.txt" }).click();
  await expect(page.getByTestId("editor-file")).toHaveText("proof.txt");
  await expect.poll(() => editorText(page)).toBe("kept-across-reload\n");

  // The shell that started after the reload reads the same file.
  await runInTerminal(page, "cat proof.txt");
  await expect.poll(() => terminalText(page)).toMatch(/^kept-across-reload$/m);
});

test("Bun runs in the shell and writes files the explorer picks up", async ({ page }) => {
  await newWorkspace(page);

  await runInTerminal(page, "bun --version");
  await expect.poll(() => terminalText(page)).toMatch(/^\d+\.\d+\.\d+/m);

  await runInTerminal(page, `bun -e 'require("fs").writeFileSync("from-bun.txt", "written-by-bun\\n")'`);
  await expect(page.getByTestId("file-tree")).toContainText("from-bun.txt");
  await runInTerminal(page, "cat from-bun.txt");
  await expect.poll(() => terminalText(page)).toMatch(/^written-by-bun$/m);
});
