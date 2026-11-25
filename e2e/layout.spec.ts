import type { Page } from "@playwright/test";
import { expect, newWorkspace, runInTerminal, terminalText, test, writeFile } from "./helpers";

async function width(page: Page, selector: string): Promise<number> {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`${selector} is not on screen`);
  return box.width;
}

async function height(page: Page, selector: string): Promise<number> {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`${selector} is not on screen`);
  return box.height;
}

/** Drags a handle by `dx`, `dy` CSS pixels with the mouse. */
async function drag(page: Page, testId: string, dx: number, dy: number): Promise<void> {
  const box = await page.getByTestId(testId).boundingBox();
  if (!box) throw new Error(`${testId} is not on screen`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
  await page.mouse.move(x + dx, y + dy, { steps: 4 });
  await page.mouse.up();
}

test("pane sizes and closed panes survive a reload", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await newWorkspace(page);
  await expect(page.getByTestId("terminal-panel")).toBeVisible();

  const explorer = await width(page, "#wb-slot-files");
  await drag(page, "splitter-explorer", 96, 0);
  await expect.poll(() => width(page, "#wb-slot-files")).toBeGreaterThan(explorer + 80);
  const dragged = await width(page, "#wb-slot-files");

  // The terminal handle works from the keyboard: three steps up.
  const terminal = await height(page, "#wb-slot-terminal");
  await page.getByTestId("splitter-terminal").focus();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect.poll(() => height(page, "#wb-slot-terminal")).toBeGreaterThan(terminal + 40);
  const raised = await height(page, "#wb-slot-terminal");

  // Enter on the preview handle closes the preview.
  await page.getByTestId("splitter-preview").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#wb-slot-preview")).toBeHidden();

  await page.reload();
  await expect(page.getByTestId("terminal-panel")).toBeVisible();
  await expect.poll(() => width(page, "#wb-slot-files")).toBe(dragged);
  await expect.poll(() => height(page, "#wb-slot-terminal")).toBe(raised);
  await expect(page.locator("#wb-slot-preview")).toBeHidden();

  // The activity bar brings it back.
  await page.getByTestId("toggle-preview").click();
  await expect(page.locator("#wb-slot-preview")).toBeVisible();
});

type Snapshot = { when: string; theme: string | null; colorScheme: string; mounted: boolean };

test("the theme toggle sticks across a reload", async ({ page }) => {
  await newWorkspace(page);
  const systemDark = await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches);
  const [other, own] = systemDark ? ["light", "dark"] : ["dark", "light"];
  const option = (scheme: string) => page.getByRole("button", { name: scheme, exact: false });

  await option(other === "light" ? "Light" : "Dark").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", other);

  // The saved theme applies before the app's code runs. The entry bundle is a module script, so
  // it runs only after the document is parsed and the render-blocking stylesheet has loaded.
  // Snapshot the page at those two moments on the next load, with no network interception:
  // holding the bundle back by route raced with the browser's own caching.
  await page.addInitScript(() => {
    const snapshots: Snapshot[] = [];
    Object.assign(window, { sprocktBeforeApp: snapshots });
    const take = (when: string) => {
      const root = document.documentElement;
      snapshots.push({
        when,
        theme: root.getAttribute("data-theme"),
        colorScheme: getComputedStyle(root).colorScheme,
        mounted: (document.getElementById("app")?.childElementCount ?? 0) > 0,
      });
    };
    document.addEventListener("readystatechange", () => {
      if (document.readyState === "interactive") take("parsed");
    });
    document.addEventListener(
      "load",
      (event) => {
        // Only the first: the app adds its own stylesheets once it runs.
        const first = snapshots.every((snap) => snap.when !== "stylesheet");
        if (first && event.target instanceof HTMLLinkElement) take("stylesheet");
      },
      true,
    );
  });
  await page.reload();
  await expect(page.getByTestId("workbench")).toBeVisible();
  const before = await page.evaluate(
    () => (window as unknown as { sprocktBeforeApp: Snapshot[] }).sprocktBeforeApp,
  );
  expect(before.map((snap) => snap.when).toSorted()).toEqual(["parsed", "stylesheet"]);
  expect(before.find((snap) => snap.when === "stylesheet")?.colorScheme).toBe(other);
  for (const snap of before) {
    expect(snap).toMatchObject({ theme: other, mounted: false });
  }
  await expect(page.locator("html")).toHaveAttribute("data-theme", other);

  // Picking the system's own theme goes back to following the system.
  await option(own === "light" ? "Light" : "Dark").click();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /./);
});

test("clicking a handle without dragging changes nothing, and a closed preview keeps its handle", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await newWorkspace(page);
  await expect(page.getByTestId("terminal-panel")).toBeVisible();
  const sizes = async () => ({
    files: await width(page, "#wb-slot-files"),
    preview: await width(page, "#wb-slot-preview"),
    terminal: await height(page, "#wb-slot-terminal"),
  });
  const before = await sizes();
  await page.getByTestId("splitter-explorer").click();
  await page.getByTestId("splitter-preview").click();
  await page.getByTestId("splitter-terminal").click();
  expect(await sizes()).toEqual(before);

  // Enter closes the preview; its handle stays focusable and Enter opens it again.
  await page.getByTestId("splitter-preview").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#wb-slot-preview")).toBeHidden();
  await expect(page.getByTestId("splitter-preview")).toBeVisible();
  await page.getByTestId("splitter-preview").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#wb-slot-preview")).toBeVisible();

  // Dragging a closed preview's handle back out opens it.
  await page.keyboard.press("Enter");
  await expect(page.locator("#wb-slot-preview")).toBeHidden();
  await drag(page, "splitter-preview", -400, 0);
  await expect.poll(() => width(page, "#wb-slot-preview")).toBeGreaterThan(300);
});

test("a drag that snaps a pane shut and returns to where it started changes nothing", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await newWorkspace(page);
  await expect(page.getByTestId("terminal-panel")).toBeVisible();
  const preview = await width(page, "#wb-slot-preview");

  const box = await page.getByTestId("splitter-preview").boundingBox();
  if (!box) throw new Error("the preview handle is not on screen");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  // Far enough right that the preview snaps shut (inside the window), then back to 1px from the press.
  await page.mouse.move(x + preview - 40, y, { steps: 6 });
  await expect(page.locator("#wb-slot-preview")).toBeHidden();
  await page.mouse.move(x + 1, y, { steps: 6 });
  await page.mouse.up();

  await expect(page.locator("#wb-slot-preview")).toBeVisible();
  await expect.poll(() => width(page, "#wb-slot-preview")).toBe(preview);
  await page.reload();
  await expect(page.getByTestId("terminal-panel")).toBeVisible();
  await expect.poll(() => width(page, "#wb-slot-preview")).toBe(preview);
});

test("a wide saved explorer leaves the editor its room in a narrow window", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await newWorkspace(page);
  await expect(page.getByTestId("terminal-panel")).toBeVisible();
  await page.getByTestId("splitter-explorer").focus();
  await page.keyboard.press("End");
  await expect.poll(() => width(page, "#wb-slot-files")).toBe(520);

  const roomy = async () => {
    expect(await width(page, "#wb-slot-code")).toBeGreaterThanOrEqual(255);
    expect(await width(page, "#wb-slot-preview")).toBeGreaterThanOrEqual(270);
  };
  const explorerValue = async () =>
    Number(await page.getByTestId("splitter-explorer").getAttribute("aria-valuenow"));
  expect(await explorerValue()).toBe(100);
  await page.setViewportSize({ width: 800, height: 900 });
  await expect.poll(() => width(page, "#wb-slot-files")).toBeLessThan(520);
  await roomy();
  // Assistive technology hears the width on screen, not the saved one.
  expect(await explorerValue()).toBeLessThan(100);
  await page.reload();
  await expect(page.getByTestId("terminal-panel")).toBeVisible();
  await roomy();

  // The saved width comes back with the room.
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(() => width(page, "#wb-slot-files")).toBe(520);
});

test("closing a terminal while its startup command runs raises no page error", async ({
  page,
  pageErrors,
}) => {
  await newWorkspace(page);
  await expect(page.getByTestId("terminal-state")).toHaveText("ready");
  await page.evaluate(() =>
    globalThis.sprockt?.workspace?.terminals.create({
      title: "server",
      run: "echo startup-ran; read -r input",
    }),
  );
  await expect.poll(() => terminalText(page)).toMatch(/^startup-ran$/m);
  await page.getByRole("button", { name: "Close server" }).click();

  // A tab closed while its shell is still starting stops cleanly too.
  await page.evaluate(() => {
    const terminals = globalThis.sprockt?.workspace?.terminals;
    const id = terminals?.create({ title: "brief", run: "echo never" });
    if (id) terminals?.close(id);
  });
  await expect(page.getByTestId("terminal-tab")).toHaveCount(1);
  await page.getByTestId("terminal-tab").click();
  await runInTerminal(page, "echo still-fine");
  await expect.poll(() => terminalText(page)).toMatch(/^still-fine$/m);
  expect(pageErrors.filter((error) => error.startsWith("pageerror"))).toEqual([]);
});

test("losing the workspace to another tab stops this tab's shells and runtime", async ({ page, context }) => {
  const id = await newWorkspace(page);
  await runInTerminal(page, "read -r input");
  await expect(page.getByTestId("terminal-state")).toHaveText("running");

  const second = await context.newPage();
  await second.goto(`/w/${id}`);
  await second.getByTestId("take-over").click();
  await runInTerminal(second, "echo owner-now");
  await expect.poll(() => terminalText(second)).toMatch(/^owner-now$/m);

  await expect(page.getByTestId("workbench")).toHaveAttribute("data-stage", "moved");
  await expect.poll(() => page.evaluate(() => globalThis.sprockt?.workspace?.runtime.disposed)).toBe(true);
  const left = await page.evaluate(() => {
    const terminals = globalThis.sprockt?.workspace?.terminals;
    return { tabs: terminals?.tabs().tabs.length, handle: terminals?.handle("t1") === undefined };
  });
  expect(left).toEqual({ tabs: 0, handle: true });
});

// Waffle 0.0.148/0.0.149: after ownership loss, Runtime.dispose() rejects ("Runtime disposal
// failed", the quiesce calls fail with the takeover error) and keeps the filesystem worker on
// purpose. The fix belongs in Waffle's teardown; remove `fixme` when the pin moves to it.
test.fixme("losing the workspace to another tab ends this tab's filesystem worker", async ({
  page,
  context,
}) => {
  const fsWorkers = () => page.workers().filter((worker) => worker.url().includes("fs-worker")).length;
  const id = await newWorkspace(page);
  await expect(page.getByTestId("terminal-state")).toHaveText("ready");
  expect(fsWorkers()).toBeGreaterThan(0);

  const second = await context.newPage();
  await second.goto(`/w/${id}`);
  await second.getByTestId("take-over").click();
  await expect(second.getByTestId("terminal-state")).toHaveText("ready");
  await expect(page.getByTestId("workbench")).toHaveAttribute("data-stage", "moved");
  await expect.poll(fsWorkers).toBe(0);
});

test("the title bar's search field opens the editor's quick open", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await newWorkspace(page);
  await expect(page.getByTestId("terminal-state")).toHaveText("ready");
  await page.getByRole("button", { name: "Search files and commands" }).click();
  await expect(page.getByTestId("quick-open")).toBeVisible();
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("the header's search button opens quick open over the code", async ({ page }) => {
    await newWorkspace(page);
    await expect(page.getByTestId("terminal-state")).toHaveText("ready");
    await page.getByRole("button", { name: "Search files and commands" }).click();
    await expect(page.getByTestId("quick-open")).toBeVisible();
    await expect(page.locator("#wb-slot-code")).toBeVisible();
  });

  test("tapping the open file again shows the code", async ({ page }) => {
    await newWorkspace(page);
    await expect(page.getByTestId("terminal-state")).toHaveText("ready");
    await writeFile(page, "notes.txt", "hello\n");
    const switcher = page.getByTestId("pane-switcher");
    const file = page.getByRole("button", { name: "notes.txt", exact: true });
    await file.click();
    await expect(page.locator("#wb-slot-code")).toBeVisible();
    await switcher.getByRole("button", { name: "Files" }).click();
    await expect(page.locator("#wb-slot-files")).toBeVisible();
    await file.click();
    await expect(page.locator("#wb-slot-code")).toBeVisible();
    await expect(page.locator("#wb-slot-files")).toBeHidden();
  });

  test("the shell is told the terminal's real size once its pane is on screen", async ({ page }) => {
    await newWorkspace(page);
    await expect(page.getByTestId("terminal-state")).toHaveText("ready");
    await page.getByTestId("pane-switcher").getByRole("button", { name: "Terminal" }).click();
    const size = () => page.evaluate(() => globalThis.sprockt?.terminalSize?.());
    const told = async () => {
      const now = await size();
      const matches = now?.shell.columns === now?.screen.columns && now?.shell.rows === now?.screen.rows;
      return matches ? now?.shell.columns : undefined;
    };

    // The terminal starts off screen, at the 80 columns a hidden terminal measures; a phone
    // shows fewer, and the shell hears the real number when the pane appears.
    await expect.poll(told).toBeLessThan(80);
    const first = await told();

    // It keeps hearing it as the screen changes.
    await page.setViewportSize({ width: 320, height: 700 });
    await expect.poll(told).toBeLessThan(first ?? 0);
  });

  test("Ctrl lets go when another terminal takes focus", async ({ page }) => {
    await newWorkspace(page);
    const switcher = page.getByTestId("pane-switcher");
    await switcher.getByRole("button", { name: "Terminal" }).click();
    await runInTerminal(page, "echo first-ready");
    await expect.poll(() => terminalText(page)).toMatch(/^first-ready$/m);
    await page.getByTestId("new-terminal").click();
    await expect(page.getByTestId("terminal-state")).toHaveText("ready");

    const ctrl = page.getByRole("button", { name: "ctrl", exact: true });
    await ctrl.click();
    await expect(ctrl).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("terminal-tab").first().click();
    await expect(ctrl).toHaveAttribute("aria-pressed", "false");

    // Back in the second shell, a letter is a letter: no leftover Ctrl+E.
    await page.getByTestId("terminal-tab").nth(1).click();
    await runInTerminal(page, "echo second-ok");
    await expect.poll(() => terminalText(page)).toMatch(/^second-ok$/m);

    // Leaving the terminal for another pane lets go of Ctrl too.
    await ctrl.click();
    await expect(ctrl).toHaveAttribute("aria-pressed", "true");
    await switcher.getByRole("button", { name: "Files" }).click();
    await switcher.getByRole("button", { name: "Terminal" }).click();
    await expect(ctrl).toHaveAttribute("aria-pressed", "false");
    await runInTerminal(page, "echo still-letters");
    await expect.poll(() => terminalText(page)).toMatch(/^still-letters$/m);
  });

  test("the pane switcher shows one pane at a time", async ({ page }) => {
    await newWorkspace(page);
    const switcher = page.getByTestId("pane-switcher");
    await expect(switcher).toBeVisible();
    await expect(page.locator("#wb-slot-files")).toBeVisible();
    await expect(page.locator("#wb-slot-code")).toBeHidden();

    await switcher.getByRole("button", { name: "Terminal" }).click();
    await expect(page.locator("#wb-slot-terminal")).toBeVisible();
    await expect(page.locator("#wb-slot-files")).toBeHidden();
    await expect(switcher.getByRole("button", { name: "Terminal" })).toHaveAttribute("aria-pressed", "true");

    // The shell works in the phone layout too.
    await runInTerminal(page, "echo from-the-phone");
    await expect.poll(() => terminalText(page)).toMatch(/^from-the-phone$/m);

    await switcher.getByRole("button", { name: "Code" }).click();
    await expect(page.locator("#wb-slot-code")).toBeVisible();
    await expect(page.locator("#wb-slot-terminal")).toBeHidden();

    // Nothing runs off the side of the screen.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test("two terminal tabs run separate shells", async ({ page }) => {
  await newWorkspace(page);
  await runInTerminal(page, "export MARK=first; echo first-tab-ready");
  await expect.poll(() => terminalText(page)).toMatch(/^first-tab-ready$/m);

  await page.getByTestId("new-terminal").click();
  await expect(page.getByTestId("terminal-tab")).toHaveCount(2);
  await runInTerminal(page, "echo second-tab:$MARK:");
  // The second shell never saw the first one's variable.
  await expect.poll(() => terminalText(page)).toMatch(/^second-tab::$/m);

  await page.getByTestId("terminal-tab").first().click();
  await runInTerminal(page, "echo first-tab:$MARK");
  await expect.poll(() => terminalText(page)).toMatch(/^first-tab:first$/m);
  expect(await terminalText(page)).not.toContain("second-tab");

  // Closing a tab leaves the other shell running.
  await page.getByRole("button", { name: "Close bash 2" }).click();
  await expect(page.getByTestId("terminal-tab")).toHaveCount(1);
  await runInTerminal(page, "echo still-here");
  await expect.poll(() => terminalText(page)).toMatch(/^still-here$/m);
});

test("a solid button's keyboard focus ring stands out from its own fill", async ({ page, browserName }) => {
  await newWorkspace(page);
  await expect(page.getByTestId("terminal-state")).toHaveText("ready");
  await page.getByRole("button", { name: "Close bash", exact: true }).click();
  const button = page.locator(".term-empty .primary");
  await expect(button).toBeVisible();

  // Reach the button the way a keyboard user does, so the browser shows its focus ring. A click
  // on the text above it starts the walk there; Safari only tabs to buttons with Option held.
  await page.locator(".term-empty p").click();
  const tab = browserName === "webkit" ? "Alt+Tab" : "Tab";
  await expect(async () => {
    await page.keyboard.press(tab);
    await expect(button).toBeFocused({ timeout: 250 });
  }).toPass({ timeout: 30_000 });
  const ring = await button.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      shown: element.matches(":focus-visible"),
      style: style.outlineStyle,
      width: Number.parseFloat(style.outlineWidth),
      ring: style.outlineColor,
      fill: style.backgroundColor,
      text: style.color,
    };
  });
  expect(ring.shown).toBe(true);
  expect(ring.style).toBe("solid");
  expect(ring.width).toBeGreaterThanOrEqual(2);
  // The ring is drawn in the button's text color, which the fill already contrasts with.
  expect(ring.ring).toBe(ring.text);
  expect(ring.ring).not.toBe(ring.fill);
});

test("with reduced motion the boot mark stands still and the steps stay on screen", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByTestId("template-vite-react").click();
  // Read at the first frame the boot card exists: it is gone once the workspace is ready.
  const boot = await page.waitForFunction(() => {
    const mark = document.querySelector(".wb-boot-mark");
    const spinner = document.querySelector(".wb-spinner");
    if (!mark || !spinner) return undefined;
    return {
      mark: getComputedStyle(mark).animationName,
      spinner: getComputedStyle(spinner).animationName,
      steps: document.querySelectorAll(".wb-boot-steps li").length,
    };
  });
  const seen = await boot.jsonValue();
  expect(seen?.mark).toBe("none");
  expect(seen?.spinner).toBe("none");
  expect(seen?.steps).toBeGreaterThan(0);
});
