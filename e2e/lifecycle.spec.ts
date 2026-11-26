import type { Page } from "@playwright/test";
import {
  editorText,
  expect,
  newWorkspace,
  openFile,
  runInTerminal,
  test,
  typeInEditor,
  withoutAutosave,
  writeFile,
} from "./helpers";
import { TAB_POLICY } from "../src/runtime/tab-policy";

/** The keys under which text is waiting to be recovered in this browser profile. */
const recoveryKeys = (page: Page) =>
  page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("sprockt:recovery:")));

test("leaving a workspace while it boots does not block the next one", async ({ page }) => {
  await page.goto("/w/left-during-boot");
  await expect(page.getByTestId("workbench")).toBeVisible();
  // Leave at once: the runtime of this workspace is still starting.
  await page.getByRole("button", { name: "Sprockt" }).click();
  await expect(page.getByTestId("new-workspace")).toBeVisible();

  await page.getByTestId("new-workspace").click();
  await runInTerminal(page, "echo second-workspace > ok.txt");
  await expect(page.getByTestId("file-tree")).toContainText("ok.txt");
});

test("a second tab asks before it takes a workspace over, and unsaved text moves with it", async ({
  page,
  context,
}) => {
  test.skip(TAB_POLICY === "attach", "a second tab takes over only with the takeover policy");
  // With the attach policy a second tab shares the workspace instead (e2e/tabs.spec.ts).
  await withoutAutosave(page);
  const id = await newWorkspace(page);
  await expect(page.getByTestId("terminal-state")).toHaveText("ready");
  await writeFile(page, "draft.txt", "saved text\n");
  await expect(page.getByTestId("save-state")).toHaveText("saved");
  await openFile(page, "draft.txt");
  await typeInEditor(page, "not saved yet");
  await expect(page.getByTestId("editor-dirty")).toBeVisible();

  const second = await context.newPage();
  await second.goto(`/w/${id}`);
  // Nothing is taken until the person says so: the first tab keeps working.
  await expect(second.getByTestId("workspace-busy")).toBeVisible();
  await expect(page.getByTestId("workbench")).toHaveAttribute("data-stage", "ready");

  await second.getByTestId("take-over").click();
  await expect(second.getByTestId("file-tree")).toContainText("draft.txt");
  await expect(page.getByTestId("workbench")).toHaveAttribute("data-stage", "moved");

  // The first tab can no longer write, and says so instead of pretending.
  await expect(page.getByTestId("save-state")).toHaveText("failed");
  const refused = await page.evaluate(() =>
    globalThis.sprockt?.workspace?.files.write("late.txt", "x").then(
      () => "written",
      (error: Error) => error.message,
    ),
  );
  expect(refused).toContain("another tab");

  // Its unsaved text shows up in the tab that now owns the workspace, as an unsaved edit.
  await openFile(second, "draft.txt");
  await expect.poll(() => editorText(second)).toBe("saved text\nnot saved yet");
  await expect(second.getByTestId("editor-dirty")).toBeVisible();

  // Opening the file did not use the recovered text up: a reload before saving still has it.
  await page.close();
  await second.reload();
  await openFile(second, "draft.txt");
  await expect.poll(() => editorText(second)).toBe("saved text\nnot saved yet");
  await expect(second.getByTestId("editor-dirty")).toBeVisible();

  // Once it is saved and flushed, the recovered copy is gone.
  await second.keyboard.press("ControlOrMeta+s");
  await expect(second.getByTestId("editor-dirty")).toBeHidden();
  await expect(second.getByTestId("save-state")).toHaveText("saved");
  await expect.poll(() => recoveryKeys(second)).toEqual([]);
});

test("a save whose flush never finished is still handed to the tab that takes over", async ({
  page,
  context,
}) => {
  test.skip(TAB_POLICY === "attach", "a second tab takes over only with the takeover policy");
  const id = await newWorkspace(page);
  await expect(page.getByTestId("terminal-state")).toHaveText("ready");
  await writeFile(page, "draft.txt", "first\n");
  await expect(page.getByTestId("save-state")).toHaveText("saved");
  await openFile(page, "draft.txt");

  // From here on this tab never hears that a flush finished, as while storage is busy or its
  // checkpoint is cut off by the takeover. The write itself is acknowledged from memory.
  await page.evaluate(() => {
    const files = globalThis.sprockt?.workspace?.files;
    if (files) files.saved = () => new Promise<void>(() => {});
  });
  await typeInEditor(page, "acknowledged but not flushed");
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByTestId("editor-dirty")).toBeHidden();

  const second = await context.newPage();
  await second.goto(`/w/${id}`);
  await second.getByTestId("take-over").click();
  await expect(page.getByTestId("workbench")).toHaveAttribute("data-stage", "moved");
  await expect.poll(() => recoveryKeys(second)).toHaveLength(1);

  await expect(second.getByTestId("file-tree")).toContainText("draft.txt");
  await openFile(second, "draft.txt");
  await expect.poll(() => editorText(second)).toBe("first\nacknowledged but not flushed");
});

test("a tab that started opening before another one got the workspace does not take it", async ({
  page,
  context,
}) => {
  test.skip(TAB_POLICY === "attach", "a second tab takes over only with the takeover policy");
  // The first tab finds the workspace free, then its filesystem worker is held up, as on a slow
  // connection. Meanwhile a second tab opens the same workspace and gets it.
  const held = Promise.withResolvers<void>();
  await page.route(/\/assets\/fs-worker-[^/]*\.js$/, async (route) => {
    await held.promise;
    await route.continue();
  });
  const url = `/w/overlap${Date.now().toString(36)}`;
  const workerRequested = page.waitForRequest(/\/assets\/fs-worker-/);
  await page.goto(url);
  await workerRequested;

  const other = await context.newPage();
  await other.goto(url);
  await expect(other.getByTestId("terminal-state")).toHaveText("ready");

  // The first tab resumes. It must wait and ask; the second tab keeps the workspace.
  held.resolve();
  await expect(page.getByTestId("workspace-busy")).toBeVisible();
  await expect(other.getByTestId("workbench")).toHaveAttribute("data-stage", "ready");
  await expect(other.getByTestId("save-state")).toHaveText("saved");

  // Only the explicit choice moves it.
  await page.getByTestId("take-over").click();
  await expect(page.getByTestId("terminal-state")).toHaveText("ready");
  await expect(other.getByTestId("workbench")).toHaveAttribute("data-stage", "moved");
});
