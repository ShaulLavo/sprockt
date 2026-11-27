import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import type { Locator, Page } from "@playwright/test";
import {
  editorText,
  expect,
  newWorkspace,
  runInTerminal,
  test,
  typeInEditor,
  withoutAutosave,
  writeFile,
} from "./helpers";
import { TAB_POLICY } from "../src/runtime/tab-policy";

const readFile = (page: Page, path: string): Promise<string | undefined> =>
  page.evaluate((file) => globalThis.sprockt?.workspace?.files.read(file), path);

/**
 * Picks a folder with the folder input. Playwright's WebKit never returns from `setInputFiles` for
 * a directory (the call has no end in the trace, though the page does receive the folder), so there
 * the same files, each with its `webkitRelativePath`, go into the input from the page and the
 * input's own change handler runs as it does for a real pick.
 */
async function pickFolder(
  page: Page,
  browserName: string,
  directory: string,
  files: Record<string, string>,
): Promise<void> {
  const input = page.getByTestId("upload-folder-input");
  if (browserName !== "webkit") {
    await input.setInputFiles(directory);
    return;
  }
  await input.evaluate((element: HTMLInputElement, entries) => {
    const transfer = new DataTransfer();
    for (const [path, text] of Object.entries(entries)) {
      transfer.items.add(new File([text], path.slice(path.lastIndexOf("/") + 1)));
    }
    element.files = transfer.files;
    Array.from(element.files).forEach((file, index) => {
      const path = Object.keys(entries)[index] ?? "";
      Object.defineProperty(file, "webkitRelativePath", { value: path });
    });
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, files);
}

const row = (page: Page, path: string): Locator => page.locator(`[data-wb-tree-row][data-path="${path}"]`);

/** Clicks "new file" or "new folder", types the name into the inline box and confirms it. */
async function create(page: Page, kind: "file" | "folder", name: string): Promise<void> {
  await page.getByTestId(kind === "file" ? "new-file" : "new-folder").click();
  const input = page.getByTestId("wb-tree-inline-input");
  await input.fill(name);
  await input.press("Enter");
  await expect(input).toHaveCount(0);
}

/**
 * Opens a folder row. A new workspace opens its small folders by itself, so a folder may already
 * be open or about to be: click only when it is shut, and look again if that click closed it.
 * Also handles compacted single-child folder chains (`area / inner`), where intermediate segments
 * are already expanded as part of their leaf row.
 */
async function expandRow(page: Page, path: string): Promise<void> {
  const folder = row(page, path);
  const segment = page.locator(`[data-wb-drop-segment="${path}"]`);
  await expect(folder.or(segment).first()).toBeVisible();
  if ((await folder.count()) === 0) return;
  await expect(async () => {
    if ((await folder.count()) === 0 && (await segment.count()) > 0) return;
    if ((await folder.getAttribute("aria-expanded", { timeout: 1000 })) !== "true") {
      await folder.locator(".wb-tree-chevron").click({ timeout: 1000 });
    }
    if ((await folder.count()) === 0 && (await segment.count()) > 0) return;
    await expect(folder).toHaveAttribute("aria-expanded", "true", { timeout: 1000 });
  }).toPass();
}

async function saved(page: Page): Promise<void> {
  await expect(page.getByTestId("save-state")).toHaveText("saved");
}

/** The files of a ZIP, by name. Reads the central directory, so it needs no unzip library. */
function unzip(archive: Buffer): Map<string, string> {
  const files = new Map<string, string>();
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = archive.readUInt16LE(end + 10);
  let offset = archive.readUInt32LE(end + 16);
  for (let index = 0; index < count; index += 1) {
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const local = archive.readUInt32LE(offset + 42);
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    const data = archive.subarray(start, start + compressedSize);
    files.set(name, (method === 8 ? inflateRawSync(data) : data).toString("utf8"));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

test("files and folders can be created, renamed and deleted, and the tree survives a reload", async ({
  page,
}) => {
  await newWorkspace(page);

  await create(page, "folder", "docs");
  await expect(row(page, "docs")).toBeVisible();
  // The new folder is where the next new file goes.
  await expandRow(page, "docs");
  await create(page, "file", "notes.md");
  await expect(row(page, "docs/notes.md")).toBeVisible();
  await expect(page.getByTestId("editor-file")).toHaveAttribute("aria-label", "docs/notes.md");

  // F2 renames the focused row.
  await row(page, "docs/notes.md").press("F2");
  await page.getByTestId("wb-tree-inline-input").fill("readme.md");
  await page.getByTestId("wb-tree-inline-input").press("Enter");
  await expect(row(page, "docs/readme.md")).toBeVisible();
  await expect(row(page, "docs/notes.md")).toHaveCount(0);

  // The context menu renames a folder, and its open state and contents move with it.
  await row(page, "docs").click({ button: "right" });
  await page.getByTestId("menu-rename").click();
  await page.getByTestId("wb-tree-inline-input").fill("guide");
  await page.getByTestId("wb-tree-inline-input").press("Enter");
  await expect(row(page, "guide/readme.md")).toBeVisible();
  await expect(row(page, "docs")).toHaveCount(0);
  // The editor followed the folder: the open file now has its new path.
  await expect(page.getByTestId("editor-file")).toHaveAttribute("aria-label", "guide/readme.md");

  await create(page, "file", "keep.txt");
  await expect(row(page, "guide/keep.txt")).toBeVisible();
  await saved(page);

  await page.reload();
  // Folders that were open are open again, with the same files.
  await expect(row(page, "guide/readme.md")).toBeVisible();
  await expect(row(page, "guide/keep.txt")).toBeVisible();

  // Delete asks first; cancelling leaves the file alone.
  await row(page, "guide/readme.md").press("Delete");
  await expect(page.getByRole("alertdialog")).toContainText("Delete readme.md?");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(row(page, "guide/readme.md")).toBeVisible();

  await row(page, "guide/readme.md").press("Delete");
  await page.getByRole("button", { name: "Delete file" }).click();
  await expect(row(page, "guide/readme.md")).toHaveCount(0);

  // A folder goes with everything in it.
  await row(page, "guide").click({ button: "right" });
  await page.getByTestId("menu-delete").click();
  await expect(page.getByRole("alertdialog")).toContainText("Delete guide?");
  await page.getByRole("button", { name: "Delete folder" }).click();
  await expect(row(page, "guide")).toHaveCount(0);
  await expect(row(page, "guide/keep.txt")).toHaveCount(0);
  await saved(page);

  await page.reload();
  await expect(page.getByTestId("tree-empty")).toBeVisible();
  await expect(row(page, "guide")).toHaveCount(0);
});

test("a name that is taken or not allowed is refused and the box stays open", async ({ page }) => {
  await newWorkspace(page);
  await create(page, "file", "a.txt");

  await page.getByTestId("new-file").click();
  const input = page.getByTestId("wb-tree-inline-input");
  await input.fill("a.txt");
  await input.press("Enter");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(input).toBeVisible();

  await input.fill("x/y");
  await input.press("Enter");
  await expect(page.getByRole("alert")).toBeVisible();

  await input.press("Escape");
  await expect(input).toHaveCount(0);
  await expect(row(page, "a.txt")).toBeVisible();
});

test("files and folders from the desktop can be uploaded by picker and by drop, and survive a reload", async ({
  page,
  browserName,
}, testInfo) => {
  await newWorkspace(page);

  await page.getByTestId("upload-input").setInputFiles({
    name: "hello.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("hello from the picker\n"),
  });
  await expect(row(page, "hello.txt")).toBeVisible();

  // A whole folder keeps its structure.
  const project = testInfo.outputPath("site");
  mkdirSync(`${project}/css`, { recursive: true });
  const folder = { "site/index.html": "<h1>site</h1>\n", "site/css/site.css": "h1 { color: red }\n" };
  writeFileSync(`${project}/index.html`, folder["site/index.html"]);
  writeFileSync(`${project}/css/site.css`, folder["site/css/site.css"]);
  await pickFolder(page, browserName, project, folder);
  await expect(row(page, "site")).toBeVisible();
  await expandRow(page, "site");
  await expandRow(page, "site/css");
  await expect(row(page, "site/index.html")).toBeVisible();
  await expect(row(page, "site/css/site.css")).toBeVisible();

  // Dropping files from the desktop onto a folder puts them inside it.
  const transfer = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(new File(["dropped\n"], "dropped.txt", { type: "text/plain" }));
    return data;
  });
  await row(page, "site/css").dispatchEvent("dragover", { dataTransfer: transfer });
  await row(page, "site/css").dispatchEvent("drop", { dataTransfer: transfer });
  await expect(row(page, "site/css/dropped.txt")).toBeVisible();

  await page.getByTestId("file-tree").getByRole("treeitem", { name: "hello.txt", exact: true }).click();
  await expect.poll(() => editorText(page)).toBe("hello from the picker\n");
  await saved(page);

  await page.reload();
  await expect(row(page, "hello.txt")).toBeVisible();
  await expect(row(page, "site/css/dropped.txt")).toBeVisible();
});

test("dragging an entry onto a folder moves it, and onto the empty tree moves it to the top", async ({
  page,
}) => {
  await newWorkspace(page);
  await create(page, "folder", "target");
  await expect(row(page, "target")).toHaveAttribute("data-selected", "true");
  // Clicking the project name selects nothing, so the next file goes to the project root.
  await page.locator(".tree-root").click();
  await create(page, "file", "moving.txt");
  await expect(page.getByTestId("editor-file")).toHaveAttribute("aria-label", "moving.txt");
  await writeFile(page, "moving.txt", "payload");

  const transfer = await page.evaluateHandle(() => new DataTransfer());
  const drag = async (source: Locator, target: Locator) => {
    await source.dispatchEvent("dragstart", { dataTransfer: transfer });
    await target.dispatchEvent("dragover", { dataTransfer: transfer });
    await target.dispatchEvent("drop", { dataTransfer: transfer });
  };

  await drag(row(page, "moving.txt"), row(page, "target"));
  await expect(row(page, "target/moving.txt")).toBeVisible();
  await expect(row(page, "moving.txt")).toHaveCount(0);
  expect(await readFile(page, "target/moving.txt")).toBe("payload");

  await drag(row(page, "target/moving.txt"), page.locator("[data-wb-tree-scroller]"));
  await expect(row(page, "moving.txt")).toBeVisible();
  await expect(row(page, "target/moving.txt")).toHaveCount(0);

  // A folder cannot be dropped into itself: nothing happens, and nothing is left behind.
  await drag(row(page, "target"), row(page, "target"));
  await expect(row(page, "target")).toBeVisible();
  await saved(page);

  await page.reload();
  await expect(row(page, "moving.txt")).toBeVisible();
  await expect(row(page, "target/moving.txt")).toHaveCount(0);
  expect(await readFile(page, "moving.txt")).toBe("payload");
});

test("create, rename and drag-move never replace a name that was taken after the tree was listed", async ({
  page,
}) => {
  await newWorkspace(page);
  await create(page, "folder", "target");
  await expect(row(page, "target")).toHaveAttribute("data-selected", "true");
  await page.locator(".tree-root").click();
  await create(page, "file", "mover.txt");
  await expect(page.getByTestId("editor-file")).toHaveAttribute("aria-label", "mover.txt");
  await writeFile(page, "mover.txt", "mover bytes");

  // Create: the name box is open, then someone else takes the name, then the name is confirmed.
  await page.locator(".tree-root").click();
  await page.getByTestId("new-file").click();
  const input = page.getByTestId("wb-tree-inline-input");
  await writeFile(page, "taken.txt", "precious create");
  await input.fill("taken.txt");
  await input.press("Enter");
  await expect(row(page, "taken.txt")).toBeVisible();
  expect(await readFile(page, "taken.txt")).toBe("precious create");

  // Rename: the same, for a rename.
  await row(page, "mover.txt").click();
  await row(page, "mover.txt").press("F2");
  await writeFile(page, "renamed.txt", "precious rename");
  await page.getByTestId("wb-tree-inline-input").fill("renamed.txt");
  await page.getByTestId("wb-tree-inline-input").press("Enter");
  await expect(row(page, "mover.txt")).toBeVisible();
  expect(await readFile(page, "renamed.txt")).toBe("precious rename");
  expect(await readFile(page, "mover.txt")).toBe("mover bytes");

  // Drag: the destination appears in the folder after the tree last listed it.
  await expandRow(page, "target");
  await writeFile(page, "target/mover.txt", "precious drag");
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await row(page, "mover.txt").dispatchEvent("dragstart", { dataTransfer: transfer });
  await row(page, "target").dispatchEvent("dragover", { dataTransfer: transfer });
  await row(page, "target").dispatchEvent("drop", { dataTransfer: transfer });
  await expect(page.getByTestId("tree-notice")).toBeVisible();
  expect(await readFile(page, "target/mover.txt")).toBe("precious drag");
  expect(await readFile(page, "mover.txt")).toBe("mover bytes");
});

test("replacing an open folder from the terminal replaces what its open subfolders show", async ({
  page,
}) => {
  await newWorkspace(page);
  await runInTerminal(page, "mkdir -p area/inner && echo old > area/inner/old.txt");
  await expandRow(page, "area");
  await expandRow(page, "area/inner");
  await expect(row(page, "area/inner/old.txt")).toBeVisible();

  await runInTerminal(page, "rm -rf area && mkdir -p area/inner && echo new > area/inner/new.txt");
  await expect(row(page, "area/inner/new.txt")).toBeVisible();
  await expect(row(page, "area/inner/old.txt")).toHaveCount(0);
  await saved(page);

  await page.reload();
  await expect(row(page, "area/inner/new.txt")).toBeVisible();
  await expect(row(page, "area/inner/old.txt")).toHaveCount(0);
});

test("the tree always has one Tab stop, and Escape returns from the context menu to its row", async ({
  page,
}) => {
  await newWorkspace(page);
  await runInTerminal(page, "mkdir -p one/two && echo x > one/two/deep.txt && echo y > top.txt");
  await expandRow(page, "one");
  await expandRow(page, "one/two");
  await row(page, "one/two/deep.txt").focus();
  const stops = page.locator('[data-wb-tree-row][tabindex="0"]');
  await expect(stops).toHaveCount(1);

  // Collapse All hides the focused row; the tree still has exactly one way in.
  await page.getByTestId("collapse-all").click();
  await expect(row(page, "one/two/deep.txt")).toHaveCount(0);
  await expect(stops).toHaveCount(1);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await row(page, "top.txt").focus();
  await expect(stops).toHaveCount(1);

  await row(page, "top.txt").press("Shift+F10");
  await expect(page.locator("[data-wb-point-context-menu]")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-wb-point-context-menu]")).toHaveCount(0);
  await expect(row(page, "top.txt")).toBeFocused();
});

test("a folder holding unsaved edits can be renamed, moved and deleted; the editor keeps the edits", async ({
  page,
}) => {
  await withoutAutosave(page);
  await newWorkspace(page);
  await runInTerminal(page, "mkdir -p docs other && echo hello > docs/a.txt");
  await expandRow(page, "docs");
  await row(page, "docs/a.txt").click();
  await expect(page.getByTestId("editor-file")).toHaveAttribute("aria-label", "docs/a.txt");
  await expect.poll(() => editorText(page)).toBe("hello\n");
  await typeInEditor(page, "unsaved");
  await expect(page.getByTestId("editor-dirty")).toBeVisible();

  // Rename the folder: the open file follows, unsaved, and the disk keeps the saved text.
  await row(page, "docs").press("F2");
  await page.getByTestId("wb-tree-inline-input").fill("renamed");
  await page.getByTestId("wb-tree-inline-input").press("Enter");
  await expect(row(page, "renamed")).toBeVisible();
  await expect(page.getByTestId("editor-file")).toHaveAttribute("aria-label", "renamed/a.txt");
  await expect(page.getByTestId("editor-dirty")).toBeVisible();
  expect(await editorText(page)).toBe("hello\nunsaved");
  expect(await readFile(page, "renamed/a.txt")).toBe("hello\n");

  // Move it into another folder.
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await row(page, "renamed").dispatchEvent("dragstart", { dataTransfer: transfer });
  await row(page, "other").dispatchEvent("dragover", { dataTransfer: transfer });
  await row(page, "other").dispatchEvent("drop", { dataTransfer: transfer });
  await expect(row(page, "other/renamed")).toBeVisible();
  await expect(page.getByTestId("editor-file")).toHaveAttribute("aria-label", "other/renamed/a.txt");
  expect(await editorText(page)).toBe("hello\nunsaved");

  // Delete it: the tab stays open, marked deleted, with the unsaved text.
  await row(page, "other/renamed").press("Delete");
  await page.getByRole("button", { name: "Delete folder" }).click();
  await expect(row(page, "other/renamed")).toHaveCount(0);
  const tab = page.locator('[data-testid="editor-tab"][data-path="other/renamed/a.txt"]');
  await expect(tab).toHaveAttribute("data-missing", "true");
  await expect(page.getByTestId("editor-dirty")).toBeVisible();
  expect(await editorText(page)).toBe("hello\nunsaved");
  expect(await readFile(page, "other/renamed/a.txt")).toBeUndefined();
});

test("the ZIP download holds the project's files and leaves node_modules out", async ({ page }, testInfo) => {
  await newWorkspace(page);
  await page.getByTestId("upload-input").setInputFiles([
    { name: "one.txt", mimeType: "text/plain", buffer: Buffer.from("first file\n") },
    { name: "two.json", mimeType: "application/json", buffer: Buffer.from('{"two":2}\n') },
  ]);
  await expect(row(page, "two.json")).toBeVisible();
  await create(page, "folder", "src");
  await runInTerminal(page, "mkdir -p node_modules/dep && echo hidden > node_modules/dep/index.js");
  await runInTerminal(page, "echo from-shell > src/shell.txt");
  await expect(row(page, "node_modules")).toBeVisible();
  await expandRow(page, "src");
  await expect(row(page, "src/shell.txt")).toBeVisible();

  const downloading = page.waitForEvent("download");
  await page.getByTestId("download-zip").click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/\.zip$/);
  const target = testInfo.outputPath("project.zip");
  await download.saveAs(target);

  const files = unzip(readFileSync(target));
  expect(files.get("one.txt")).toBe("first file\n");
  expect(files.get("two.json")).toBe('{"two":2}\n');
  expect(files.get("src/shell.txt")).toBe("from-shell\n");
  expect(Array.from(files.keys()).some((name) => name.startsWith("node_modules"))).toBe(false);
});

test("what the terminal does to files shows up in the tree, in open folders too, and survives a reload", async ({
  page,
}) => {
  await newWorkspace(page);
  await runInTerminal(page, "mkdir -p deep/inner && echo one > deep/inner/a.txt && echo top > made.txt");
  await expect(row(page, "made.txt")).toBeVisible();
  await expandRow(page, "deep");
  await expandRow(page, "deep/inner");
  await expect(row(page, "deep/inner/a.txt")).toBeVisible();

  // A file created inside an already open, lazily loaded folder appears without a reload.
  await runInTerminal(page, "echo two > deep/inner/b.txt");
  await expect(row(page, "deep/inner/b.txt")).toBeVisible();

  await runInTerminal(page, "rm made.txt deep/inner/a.txt");
  await expect(row(page, "made.txt")).toHaveCount(0);
  await expect(row(page, "deep/inner/a.txt")).toHaveCount(0);
  await saved(page);

  await page.reload();
  await expect(row(page, "deep/inner/b.txt")).toBeVisible();
  await expect(row(page, "made.txt")).toHaveCount(0);
});

test("renaming a folder takes an unsaved file under node_modules along", async ({ page }) => {
  await withoutAutosave(page);
  await newWorkspace(page);
  await runInTerminal(page, "mkdir -p node_modules/pkg && echo x > node_modules/pkg/index.js");
  await expandRow(page, "node_modules");
  await expandRow(page, "node_modules/pkg");
  await row(page, "node_modules/pkg/index.js").click();
  await expect(page.getByTestId("editor-file")).toHaveAttribute("aria-label", "node_modules/pkg/index.js");
  await expect.poll(() => editorText(page)).toBe("x\n");
  await typeInEditor(page, "unsaved");
  await expect(page.getByTestId("editor-dirty")).toBeVisible();

  // `node_modules` compacts with its single child `pkg`; clicking its segment selects it for F2 rename.
  const nodeModulesSegment = page.locator('[data-wb-drop-segment="node_modules"]');
  if ((await nodeModulesSegment.count()) > 0) {
    await nodeModulesSegment.click();
    await page.keyboard.press("F2");
  } else {
    await row(page, "node_modules").press("F2");
  }
  await page.getByTestId("wb-tree-inline-input").fill("modules");
  await page.getByTestId("wb-tree-inline-input").press("Enter");
  await expect(
    row(page, "modules").or(page.locator('[data-wb-drop-segment="modules"]')).first(),
  ).toBeVisible();
  await expect(page.getByTestId("editor-file")).toHaveAttribute("aria-label", "modules/pkg/index.js");
  await expect(page.getByTestId("editor-dirty")).toBeVisible();
  expect(await editorText(page)).toBe("x\nunsaved");
});

test("a new workspace shows its small folders open, and keeps what the person then closes", async ({
  page,
}) => {
  await newWorkspace(page);
  await runInTerminal(page, "mkdir -p p/q && echo 1 > p/q/r.txt && echo 2 > p/top.txt");
  // Nothing was clicked: the folders opened by themselves.
  await expect(row(page, "p/q/r.txt")).toBeVisible();
  await expect(row(page, "p/top.txt")).toBeVisible();

  // Closing one is the person's choice; it stays closed through a reload.
  await row(page, "p/q").click();
  await expect(row(page, "p/q/r.txt")).toHaveCount(0);
  await saved(page);
  await page.reload();
  await expect(row(page, "p/top.txt")).toBeVisible();
  await expect(row(page, "p/q")).toHaveAttribute("aria-expanded", "false");
  await expect(row(page, "p/q/r.txt")).toHaveCount(0);
});

test("the arrow keys walk the tree, right opens a folder and Enter opens a file", async ({ page }) => {
  await newWorkspace(page);
  await create(page, "folder", "src");
  await page.locator(".tree-root").click();
  await create(page, "file", "readme.md");
  // A new file is selected and opened a moment after its name is confirmed; wait for that.
  await expect(page.getByTestId("editor-file")).toHaveAttribute("aria-label", "readme.md");
  await expandRow(page, "src");
  await create(page, "file", "main.ts");
  await expect(page.getByTestId("editor-file")).toHaveAttribute("aria-label", "src/main.ts");

  await row(page, "src").press("ArrowLeft");
  await expect(row(page, "src/main.ts")).toHaveCount(0);
  await page.keyboard.press("ArrowRight");
  await expect(row(page, "src/main.ts")).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(row(page, "src/main.ts")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(row(page, "readme.md")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("editor-file")).toHaveAttribute("aria-label", "readme.md");
  await page.keyboard.press("Home");
  await expect(row(page, "src")).toBeFocused();
});

test("a file created in a second tab appears in the first tab's tree", async ({ page, context }) => {
  test.skip(TAB_POLICY !== "attach", "tabs share a workspace only with the attach policy");
  const id = await newWorkspace(page);
  const second = await context.newPage();
  await second.goto(`/w/${id}`);
  await runInTerminal(second, "echo from-the-second-tab > shared.txt");
  await expect(row(page, "shared.txt")).toBeVisible();
});

test("filtering finds files in unopened folders, batch drag preflights collisions, and reload restores scroll", async ({
  page,
}) => {
  const id = await newWorkspace(page);
  // Stop auto-open before creating folders so `closed` and `dest` are never opened or listed first.
  await page.getByTestId("collapse-all").click();
  const filler = Array.from({ length: 100 }, (_, i) => `f-${String(i + 1).padStart(3, "0")}.txt`).join(" ");
  await runInTerminal(
    page,
    `mkdir -p closed dest && touch closed/needle.txt a.txt b.txt dest/b.txt ${filler}`,
  );
  await expect(row(page, "closed")).toBeVisible();
  await expect(row(page, "dest")).toBeVisible();
  await expect(row(page, "f-001.txt")).toBeVisible();
  await expect(row(page, "closed")).toHaveAttribute("aria-expanded", "false");
  await expect(row(page, "dest")).toHaveAttribute("aria-expanded", "false");

  // Filter finds closed/needle.txt even though closed was never opened, and F2 opens inline rename.
  await row(page, "closed").focus();
  await page.keyboard.type("needle");
  await expect(row(page, "closed/needle.txt")).toBeVisible();
  await row(page, "closed/needle.txt").focus();
  await page.keyboard.press("F2");
  await expect(page.getByTestId("wb-tree-inline-input")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("wb-tree-inline-input")).toHaveCount(0);
  await page.getByTestId("collapse-all").click();
  await expect(row(page, "dest")).toHaveAttribute("aria-expanded", "false");

  // Multi-select drag of [a.txt, b.txt] into unopened dest (which already has b.txt) refuses before moving a.txt.
  await row(page, "a.txt").click();
  await row(page, "b.txt").click({ modifiers: ["Shift"] });
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await row(page, "a.txt").dispatchEvent("dragstart", { dataTransfer: transfer });
  await row(page, "dest").dispatchEvent("dragover", { dataTransfer: transfer });
  await row(page, "dest").dispatchEvent("drop", { dataTransfer: transfer });
  await expect(page.getByTestId("tree-notice")).toContainText("b.txt");
  await expect(row(page, "a.txt")).toBeVisible();

  // Reloading restores the saved scroll offset once the 100 lazy root rows load.
  const scroller = page.locator("[data-wb-tree-scroller]");
  await scroller.evaluate((el) => {
    el.scrollTop = 800;
  });
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThanOrEqual(700);
  await saved(page);
  await page.goto(`/w/${id}`);
  await expect(page.getByTestId("file-tree")).toBeVisible();
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThanOrEqual(700);
});
