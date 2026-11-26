import { editorText, expect, newWorkspace, runInTerminal, terminalText, test } from "./helpers";
import { LANDING_COPY } from "../src/landing/copy";

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

test("Bun runs in the shell and writes files the explorer picks up", async ({ page }) => {
  await newWorkspace(page);

  // The version the landing page states is the one the pinned guest prints.
  const stated = /\d+\.\d+\.\d+/.exec(LANDING_COPY.heroPill)?.[0];
  expect(stated, "the landing copy names a Bun version").toBeDefined();
  await runInTerminal(page, "bun --version");
  await expect.poll(() => terminalText(page)).toMatch(/^\d+\.\d+\.\d+/m);
  const printed = /^\d+\.\d+\.\d+/m.exec(await terminalText(page))?.[0];
  expect(printed).toBe(stated);

  await runInTerminal(page, `bun -e 'require("fs").writeFileSync("from-bun.txt", "written-by-bun\\n")'`);
  await expect(page.getByTestId("file-tree")).toContainText("from-bun.txt");
  await runInTerminal(page, "cat from-bun.txt");
  await expect.poll(() => terminalText(page)).toMatch(/^written-by-bun$/m);
});
