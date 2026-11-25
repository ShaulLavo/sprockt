import { editorText, expect, newWorkspace, runInTerminal, terminalText, test } from "./helpers";

test("a workspace boots, the shell runs, and files survive a reload", async ({ page }) => {
  await newWorkspace(page);
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);

  await runInTerminal(page, "echo kept-across-reload > proof.txt");
  await expect(page.getByTestId("file-tree")).toContainText("proof.txt");
  await expect(page.getByTestId("save-state")).toHaveText("saved");

  await page.reload();
  await expect(page.getByTestId("file-tree")).toContainText("proof.txt");
  await page.getByRole("button", { name: "proof.txt" }).click();
  await expect(page.getByTestId("editor-file")).toHaveText("proof.txt");
  await expect.poll(() => editorText(page)).toBe("kept-across-reload\n");

  // The shell that started after the reload reads the same file.
  await runInTerminal(page, "cat proof.txt");
  await expect.poll(() => terminalText(page)).toMatch(/^kept-across-reload$/m);
});

test("Bun runs in the shell and writes files the explorer picks up", async ({ page, browserName }) => {
  // In Playwright's WebKit `bun --version` ends in a WASM trap; the shell and coreutils work.
  // Remove when Bun's browser engine runs there (ARCHITECTURE.md "Known gaps").
  test.fixme(browserName === "webkit", "Bun's browser engine traps in WebKit");
  await newWorkspace(page);

  await runInTerminal(page, "bun --version");
  await expect.poll(() => terminalText(page)).toMatch(/^\d+\.\d+\.\d+/m);

  await runInTerminal(page, `bun -e 'require("fs").writeFileSync("from-bun.txt", "written-by-bun\\n")'`);
  await expect(page.getByTestId("file-tree")).toContainText("from-bun.txt");
  await runInTerminal(page, "cat from-bun.txt");
  await expect.poll(() => terminalText(page)).toMatch(/^written-by-bun$/m);
});

test("a second tab takes the workspace over and the first tab says so", async ({ page, context }) => {
  const id = await newWorkspace(page);
  await runInTerminal(page, "echo from-the-first-tab > first.txt");
  await expect(page.getByTestId("save-state")).toHaveText("saved");

  const second = await context.newPage();
  await second.goto(`/w/${id}`);
  await expect(second.getByTestId("file-tree")).toContainText("first.txt");
  await expect(page.getByTestId("workbench")).toHaveAttribute("data-stage", "moved");
});

// Needs `whenBusy: "attach"` (TAB_POLICY in src/runtime/boot.ts). With it, Waffle 0.0.148 loses
// file bytes for programs: `cat` prints nothing and a shell redirect leaves an empty file.
// Remove `fixme` when the fix is pinned and the policy is back on "attach".
test.fixme("a second tab attaches to the same workspace and sees its files live", async ({
  page,
  context,
}) => {
  const id = await newWorkspace(page);
  await expect(page.getByTestId("terminal-state")).toHaveText("ready");

  const second = await context.newPage();
  await second.goto(`/w/${id}`);
  await runInTerminal(second, "echo from-the-second-tab > shared.txt");

  // The first tab learns about the file from the filesystem watcher, without a reload.
  await expect(page.getByTestId("file-tree")).toContainText("shared.txt");
  await runInTerminal(page, "cat shared.txt");
  await expect.poll(() => terminalText(page)).toMatch(/^from-the-second-tab$/m);
});
