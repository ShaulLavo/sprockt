import type { Page } from "@playwright/test";
import {
  editorText,
  expect,
  newWorkspace,
  openFile,
  runInTerminal,
  terminalText,
  test,
  writeFile,
} from "./helpers";
import { TAB_POLICY } from "../src/runtime/tab-policy";

// Two tabs on one workspace share its files live (Waffle `whenBusy: "attach"`). Each tab runs its
// own shells; files, the explorer and saved state are shared. With the takeover policy a second
// tab asks first and takes the workspace instead; e2e/lifecycle.spec.ts covers that.
test.skip(TAB_POLICY !== "attach", "tabs share a workspace only with the attach policy");

async function openSecondTab(page: Page, id: string): Promise<Page> {
  const second = await page.context().newPage();
  await second.goto(`/w/${id}`);
  await expect(second.getByTestId("terminal-state")).toHaveText("ready");
  return second;
}

test("a second tab opens the same workspace and sees its files without taking it over", async ({ page }) => {
  const id = await newWorkspace(page);
  await runInTerminal(page, "echo from-the-first-tab > first.txt");
  await expect(page.getByTestId("file-tree")).toContainText("first.txt");

  const second = await openSecondTab(page, id);
  await expect(second.getByTestId("workspace-busy")).toHaveCount(0);
  await expect(second.getByTestId("file-tree")).toContainText("first.txt");
  await runInTerminal(second, "cat first.txt");
  await expect.poll(() => terminalText(second)).toMatch(/^from-the-first-tab$/m);
  // Nobody was pushed out.
  await expect(page.getByTestId("workbench")).toHaveAttribute("data-stage", "ready");
});

test("a change in either tab shows up in the other one live", async ({ page }) => {
  const id = await newWorkspace(page);
  const second = await openSecondTab(page, id);

  // A program in the second tab writes; the first tab's explorer picks it up without a reload.
  await runInTerminal(second, "echo from-the-second-tab > shared.txt");
  await expect(page.getByTestId("file-tree")).toContainText("shared.txt");
  await runInTerminal(page, "cat shared.txt");
  await expect.poll(() => terminalText(page)).toMatch(/^from-the-second-tab$/m);

  // A page write in the first tab reaches the second tab's explorer and editor.
  await writeFile(page, "notes.txt", "written by the first tab\n");
  await expect(page.getByTestId("save-state")).toHaveText("saved");
  await expect(second.getByTestId("file-tree")).toContainText("notes.txt");
  await openFile(second, "notes.txt");
  await expect.poll(() => editorText(second)).toBe("written by the first tab\n");
});

test("when the tab that hosts the files closes, the other tab keeps working", async ({ page }) => {
  const id = await newWorkspace(page);
  await runInTerminal(page, "echo before > before.txt");
  await expect(page.getByTestId("save-state")).toHaveText("saved");
  const second = await openSecondTab(page, id);

  // The first tab hosts the filesystem; closing it hands the files to the second tab.
  await page.close();
  await runInTerminal(second, "echo after > after.txt; cat before.txt");
  await expect.poll(() => terminalText(second)).toMatch(/^before$/m);
  await expect(second.getByTestId("file-tree")).toContainText("after.txt");
  await expect(second.getByTestId("save-state")).toHaveText("saved");

  // What the surviving tab wrote is stored: a reload still has it.
  await second.reload();
  await expect(second.getByTestId("file-tree")).toContainText("after.txt");
});
