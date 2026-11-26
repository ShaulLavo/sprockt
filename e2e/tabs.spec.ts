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
  withoutAutosave,
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
  // Both tabs save by hand at one moment; autosave would settle the race before it starts.
  await withoutAutosave(page);
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
  await withoutAutosave(page);
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

const conditionalSave = (tab: Page, path: string, text: string, expected: string) =>
  tab.evaluate(
    ([file, content, before]) => globalThis.sprockt!.workspace!.files.writeIfUnchanged(file, content, before),
    [path, text, expected] as const,
  );
const remove = (tab: Page, path: string) =>
  tab.evaluate((target) => globalThis.sprockt!.workspace!.files.remove(target), path);

/** One tab saves a file while another moves or deletes its folder, at the same moment. */
async function folderRace(page: Page, second: Page, round: number, how: "move" | "delete"): Promise<void> {
  const folder = `src-${how}-${round}`;
  await writeFile(page, `${folder}/file.txt`, "old\n");
  const [saved] = await Promise.all([
    conditionalSave(page, `${folder}/file.txt`, "new\n", "old\n"),
    how === "move" ? move(second, folder, `moved-${round}`) : remove(second, folder),
  ]);
  // The folder never comes back. The save either came first (and moved or went with the folder)
  // or found its folder gone and reports a conflict with a deleted file.
  expect(await fileText(page, `${folder}/file.txt`)).toBeUndefined();
  if (!saved.written) expect(saved.current).toBeUndefined();
  if (how === "move")
    expect(await fileText(page, `moved-${round}/file.txt`)).toBe(saved.written ? "new\n" : "old\n");
}

for (const how of ["move", "delete"] as const) {
  test(`a save racing another tab's ${how} of its folder never brings the folder back`, async ({ page }) => {
    const id = await newWorkspace(page);
    const second = await openSecondTab(page, id);
    for (let round = 0; round < 5; round++) {
      // oxlint-disable-next-line no-await-in-loop
      await folderRace(page, second, round, how);
    }
  });
}

/** `alias` links to `real`, so `real/sub/x` and `alias/sub/x` name one file. */
async function makeAlias(page: Page): Promise<void> {
  // The base programs have no `ln`, so Bun makes the link.
  await writeFile(page, "link.ts", `require("fs").symlinkSync("real", "alias"); console.log("link made");\n`);
  await runInTerminal(page, "bun link.ts");
  await expect.poll(() => terminalText(page)).toMatch(/^link made$/m);
}

/** Two tabs save one file at the same moment, one through the link and one through its target. */
async function aliasedSaveRace(page: Page, second: Page, round: number): Promise<void> {
  await writeFile(page, `real/sub/file-${round}.txt`, "base\n");
  const outcomes = await Promise.all([
    conditionalSave(page, `real/sub/file-${round}.txt`, "through the folder\n", "base\n"),
    conditionalSave(second, `alias/sub/file-${round}.txt`, "through the link\n", "base\n"),
  ]);
  expect(outcomes.filter((outcome) => outcome.written)).toHaveLength(1);
}

test("two tabs saving one file through a folder link and its target: one lands", async ({ page }) => {
  const id = await newWorkspace(page);
  await writeFile(page, "real/sub/keep.txt", "");
  await makeAlias(page);
  const second = await openSecondTab(page, id);
  for (let round = 0; round < 5; round++) {
    // oxlint-disable-next-line no-await-in-loop
    await aliasedSaveRace(page, second, round);
  }
});

/** Two tabs move files to one free name at the same moment, spelled through the link and its target. */
async function aliasedMoveRace(page: Page, second: Page, round: number): Promise<void> {
  await writeFile(page, `a-${round}.txt`, "first payload");
  await writeFile(page, `b-${round}.txt`, "second payload");
  const moves = await Promise.allSettled([
    move(page, `a-${round}.txt`, `real/sub/out-${round}.txt`),
    move(second, `b-${round}.txt`, `alias/sub/out-${round}.txt`),
  ]);
  expect(moves.map((result) => result.status).toSorted()).toEqual(["fulfilled", "rejected"]);
  const kept = moves[0].status === "rejected" ? `a-${round}.txt` : `b-${round}.txt`;
  expect(await fileText(page, kept)).toBe(kept.startsWith("a-") ? "first payload" : "second payload");
}

test("two tabs moving files to one free name through a folder link and its target: one fails", async ({
  page,
}) => {
  const id = await newWorkspace(page);
  await writeFile(page, "real/sub/keep.txt", "");
  await makeAlias(page);
  const second = await openSecondTab(page, id);
  for (let round = 0; round < 5; round++) {
    // oxlint-disable-next-line no-await-in-loop
    await aliasedMoveRace(page, second, round);
  }
});
