import {
  editorText,
  expect,
  newWorkspace,
  openFile,
  runInTerminal,
  test,
  typeInEditor,
  writeFile,
} from "./helpers";

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
});
