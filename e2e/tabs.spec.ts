import type { Page } from "@playwright/test";
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

const save = (page: Page) => page.keyboard.press("ControlOrMeta+s");
const fileText = (page: Page, path: string) =>
  page.evaluate((file) => globalThis.sprockt?.workspace?.files.read(file), path);

/** Both tabs edit one file differently and save at the same moment. */
async function saveRace(page: Page, second: Page, name: string): Promise<void> {
  await writeFile(page, name, "base\n");
  await expect(second.getByTestId("file-tree")).toContainText(name);
  await openFile(page, name);
  await openFile(second, name);
  await typeInEditor(page, "first tab");
  await typeInEditor(second, "second tab");
  await Promise.all([save(page), save(second)]);

  // Whichever save wrote last, nothing was replaced unseen: the other tab shows a conflict and
  // still has its own text.
  await expect.poll(() => fileText(page, name)).toMatch(/^base\n(first|second) tab$/);
  const landed = await fileText(page, name);
  const [loser, draft] =
    landed === "base\nfirst tab" ? [second, "base\nsecond tab"] : [page, "base\nfirst tab"];
  await expect(loser.getByTestId("editor-conflict")).toBeVisible();
  await expect.poll(() => editorText(loser)).toBe(draft);
  await loser.getByTestId("conflict-reload").click();
  await expect.poll(() => editorText(loser)).toBe(landed);
}

test("two tabs saving one file at once: one save lands, the other tab keeps its text as a conflict", async ({
  page,
}) => {
  const id = await newWorkspace(page);
  const second = await openSecondTab(page, id);
  for (let attempt = 0; attempt < 5; attempt++) {
    // One race at a time: each needs both editors to itself.
    // oxlint-disable-next-line no-await-in-loop
    await saveRace(page, second, `race-${attempt}.txt`);
  }
});

const move = (tab: Page, from: string, to: string) =>
  tab.evaluate(([source, target]) => globalThis.sprockt!.workspace!.files.move(source, target), [
    from,
    to,
  ] as const);

/** Two tabs move different files to one free name at the same moment. */
async function moveRace(page: Page, first: Page, second: Page, attempt: number): Promise<void> {
  await writeFile(page, `a-${attempt}.txt`, "first payload");
  await writeFile(page, `b-${attempt}.txt`, "second payload");
  const out = `out-${attempt}.txt`;
  const moves = await Promise.allSettled([
    move(first, `a-${attempt}.txt`, out),
    move(second, `b-${attempt}.txt`, out),
  ]);
  expect(moves.map((result) => result.status).toSorted()).toEqual(["fulfilled", "rejected"]);
  const kept = moves[0].status === "rejected" ? `a-${attempt}.txt` : `b-${attempt}.txt`;
  const keptPayload = kept.startsWith("a-") ? "first payload" : "second payload";
  expect(await fileText(page, kept)).toBe(keptPayload);
  expect(await fileText(page, out)).not.toBe(keptPayload);
}

test("two tabs moving files to one free name at once: one move fails and keeps its file", async ({
  page,
}) => {
  const id = await newWorkspace(page);
  const [first, second] = [await openSecondTab(page, id), await openSecondTab(page, id)];
  for (let attempt = 0; attempt < 5; attempt++) {
    // oxlint-disable-next-line no-await-in-loop
    await moveRace(page, first, second, attempt);
  }
});

test("a save that never reached storage survives the hosting tab closing, as a conflict", async ({
  page,
}) => {
  const id = await newWorkspace(page);
  await writeFile(page, "notes.txt", "durable\n");
  await expect(page.getByTestId("save-state")).toHaveText("saved");
  const second = await openSecondTab(page, id);
  await openFile(second, "notes.txt");

  // The hosting tab's storage refuses every write from now on.
  const hostFilesystem = page.workers().find((worker) => worker.url().includes("fs-worker"));
  expect(hostFilesystem).toBeDefined();
  await hostFilesystem!.evaluate(() => {
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (stores, mode, options) {
      if (mode === "readwrite" && Array.isArray(stores) && stores.includes("journal")) {
        throw new DOMException("Injected persistence failure", "QuotaExceededError");
      }
      return transaction.call(this, stores, mode, options);
    };
  });
  await typeInEditor(second, "second tab's work");
  await save(second);
  await expect(second.getByTestId("save-state")).toHaveText("failed");
  // Storage does not hold the save, so the edit is still unsaved.
  await expect(second.getByTestId("editor-dirty")).toBeVisible();

  await page.close();
  // The files come back from storage without the save. The editor keeps its text and says so.
  await expect(second.getByTestId("editor-conflict")).toBeVisible();
  await expect.poll(() => editorText(second)).toBe("durable\nsecond tab's work");
  await second.getByTestId("conflict-keep").click();
  await expect.poll(() => fileText(second, "notes.txt")).toBe("durable\nsecond tab's work");
  await expect(second.getByTestId("save-state")).toHaveText("saved");
  await expect(second.getByTestId("editor-dirty")).toHaveCount(0);
});
