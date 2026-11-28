import { gzipSync } from "node:zlib";
import type { Page, Route } from "@playwright/test";
import { buildTar, paxBody, type TarFixtureEntry } from "../src/importer/github/tar-writer.ts";
import { TAB_POLICY } from "../src/runtime/tab-policy";
import { expect, newWorkspace, runInTerminal, terminalText, test, writeFile } from "./helpers";

const SERVER = (heading: string, port: number) => `
console.log("DEV_BOOT_${port}");
Bun.serve({
  port: ${port},
  fetch: () =>
    new Response("<!doctype html><html><head><title>${heading}</title></head><body><h1>${heading}</h1></body></html>", {
      headers: { "content-type": "text/html; charset=utf-8" },
    }),
});
`;

function archive(files: Readonly<Record<string, string>>): Buffer {
  const root = "auto-app-0123456";
  const entries: TarFixtureEntry[] = [
    {
      path: "pax_global_header",
      type: "g",
      bytes: paxBody({ comment: "0123456789abcdef0123456789abcdef01234567" }),
    },
    { path: `${root}/`, type: "5", mode: 0o775 },
  ];
  const fileEntries = Object.entries(files).map(([path, text]) => ({ path: `${root}/${path}`, bytes: text }));
  return gzipSync(buildTar(entries.concat(fileEntries)));
}

const frame = (page: Page) => page.frameLocator("[data-testid=wb-preview-iframe]");

test.beforeEach(({ browserName }) => {
  test.skip(
    browserName === "webkit",
    "mounted previews run in Chromium and Firefox; WebKit runs isolated previews",
  );
});

test("starting dev server unhides terminal, streams live output in a dev tab, and honors Ctrl-C", async ({
  page,
}) => {
  await newWorkspace(page);
  await writeFile(page, "server.ts", SERVER("Visible Dev Terminal", 3000));
  await expect(page.getByTestId("save-state")).toHaveText("saved");

  // Hide the terminal completely first so Start must reveal it.
  await page.getByTestId("toggle-terminal").click();
  await expect(page.getByTestId("workbench")).toHaveAttribute("data-terminal", "hidden");

  await page.getByTestId("preview-start").click();

  // Terminal auto-reveals and opens a dedicated `dev` tab with live stdout.
  await expect(page.getByTestId("workbench")).toHaveAttribute("data-terminal", "open");
  const devTab = page.locator('[data-wb-term-session] [role="tab"]', { hasText: "dev" });
  await expect(devTab).toBeVisible();
  await expect(devTab).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => terminalText(page), { timeout: 15_000 }).toContain("DEV_BOOT_3000");

  // Preview auto-connects to the listening server.
  await expect(page.getByTestId("wb-preview-port-select")).toHaveValue("3000", { timeout: 15_000 });
  await expect(frame(page).getByRole("heading")).toHaveText("Visible Dev Terminal");
  await expect(page.getByTestId("preview-task")).toHaveAttribute("data-status", "running");

  // Pressing Ctrl-C inside the visible dev terminal stops the server cleanly.
  await page.locator(".wb-terminal-stage").click();
  await page.keyboard.press("Control+c");
  await expect(page.getByTestId("preview-task")).toHaveAttribute("data-status", "stopped", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("wb-preview-port-select")).toHaveCount(0);
});

test("GitHub import auto-starts the dev server once in a visible dev terminal and not again on reload", async ({
  page,
}) => {
  const repoFiles = {
    "server.ts": SERVER("Auto-started Import", 3000),
  };
  await page.route("**/api/github/**", async (route: Route) => {
    const path = new URL(route.request().url()).pathname.slice("/api/github".length);
    if (path === "/repo/acme/auto-app") {
      return route.fulfill({
        status: 200,
        json: { owner: "acme", repo: "auto-app", defaultBranch: "main", sizeKiB: 1 },
      });
    }
    if (path === "/archive/acme/auto-app/main") {
      return route.fulfill({
        status: 200,
        body: archive(repoFiles),
        headers: { "content-type": "application/gzip" },
      });
    }
    return route.fulfill({ status: 404, json: { error: "not-found", message: "missing" } });
  });

  await page.goto("/github/acme/auto-app");
  await expect(page).toHaveURL(/\/w\/[a-z0-9]+$/);
  await expect(page.locator('[data-wb-term-session] [role="tab"]', { hasText: "dev" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(frame(page).getByRole("heading")).toHaveText("Auto-started Import", { timeout: 20_000 });
  await expect(page.getByTestId("preview-task")).toHaveAttribute("data-status", "running");

  // Stop, reload, and verify pendingImport was consumed so the server does not auto-start again.
  await page.getByTestId("preview-task").click();
  await expect(page.getByTestId("preview-task")).toHaveAttribute("data-status", "stopped");
  await page.reload();
  await expect(page.getByTestId("terminal-state")).toHaveText("ready", { timeout: 20_000 });
  await expect(page.getByTestId("preview-task")).toHaveAttribute("data-status", "stopped");
  await expect(page.getByTestId("preview-start")).toBeVisible();
});

test("monorepo app picker starts chosen workspace apps and switches between multiple preview ports", async ({
  page,
}) => {
  await newWorkspace(page);
  await expect.poll(() => page.evaluate(() => globalThis.sprockt?.workspace !== undefined)).toBe(true);
  await page.evaluate((files) => globalThis.sprockt?.workspace?.files.writeMany(files), {
    "package.json": JSON.stringify({ name: "mono", private: true, workspaces: ["apps/*"] }),
    "node_modules/.keep": "",
    "apps/web/package.json": JSON.stringify({ name: "web", scripts: { dev: "bun server.ts -p 3101" } }),
    "apps/web/server.ts": SERVER("Mono Web App", 3101),
    "apps/api/package.json": JSON.stringify({ name: "api", scripts: { dev: "bun server.ts -p 3102" } }),
    "apps/api/server.ts": SERVER("Mono API App", 3102),
  });
  await expect(page.getByTestId("save-state")).toHaveText("saved");

  // Both monorepo apps appear in the target picker.
  const targetSelect = page.getByTestId("preview-target-select");
  await expect(targetSelect).toBeVisible();
  await expect(targetSelect.locator("option")).toHaveText(["api · dev", "web · dev"]);

  // Pick web · dev and start it in the dev terminal.
  await targetSelect.selectOption("apps/web:dev");
  await page.getByTestId("preview-start").click();
  await expect(frame(page).getByRole("heading")).toHaveText("Mono Web App", { timeout: 15_000 });
  const portSelect = page.getByTestId("wb-preview-port-select");
  await expect(portSelect).toHaveValue("3101");
  await expect(portSelect.locator('option[value="3101"]')).toHaveText(":3101 · web");

  // Start the second workspace server in the original bash tab so both ports listen at once.
  await page.locator('[data-wb-term-session] [role="tab"]', { hasText: "bash" }).click();
  await runInTerminal(page, "(cd apps/api && bun server.ts)");
  await expect(portSelect.locator("option")).toHaveCount(2, { timeout: 15_000 });
  await expect(portSelect.locator('option[value="3102"]')).toHaveText(":3102 · api");

  // Switch between the two live ports in the preview switcher.
  await portSelect.selectOption("3102");
  await expect(frame(page).getByRole("heading")).toHaveText("Mono API App");
  await portSelect.selectOption("3101");
  await expect(frame(page).getByRole("heading")).toHaveText("Mono Web App");
});

test("git and rg run cleanly inside Sprockt terminals", async ({ page }) => {
  await newWorkspace(page);
  await writeFile(page, "notes.txt", "hello waffle ripgrep marker\n");
  await expect(page.getByTestId("save-state")).toHaveText("saved");

  await runInTerminal(page, "rg 'ripgrep marker' notes.txt");
  await expect.poll(() => terminalText(page), { timeout: 15_000 }).toContain("hello waffle ripgrep marker");

  await runInTerminal(page, "git --version && git init && git status");
  await expect.poll(() => terminalText(page), { timeout: 20_000 }).toContain("notes.txt");
});

test("dev terminal survives interactive cd and shell exit across restarts", async ({ page }) => {
  await newWorkspace(page);
  await expect.poll(() => page.evaluate(() => globalThis.sprockt?.workspace !== undefined)).toBe(true);
  await page.evaluate((files) => globalThis.sprockt?.workspace?.files.writeMany(files), {
    "server.ts": SERVER("Anchored Dev", 3000),
    "nested/keep.txt": "ok\n",
  });
  await expect(page.getByTestId("save-state")).toHaveText("saved");

  await page.getByTestId("preview-start").click();
  await expect(frame(page).getByRole("heading")).toHaveText("Anchored Dev", { timeout: 15_000 });

  // Stop the server, change directory inside the reused dev tab, and start again.
  await page.getByTestId("preview-task").click();
  await expect(page.getByTestId("preview-task")).toHaveAttribute("data-status", "stopped");
  await runInTerminal(page, "cd nested && pwd");
  await expect.poll(() => terminalText(page), { timeout: 15_000 }).toContain("/workspace/nested");

  await page.getByTestId("preview-start").click();
  await expect(frame(page).getByRole("heading")).toHaveText("Anchored Dev", { timeout: 15_000 });

  // Stop again, exit the dev shell completely, and confirm Start creates a fresh dev tab.
  await page.getByTestId("preview-task").click();
  await expect(page.getByTestId("preview-task")).toHaveAttribute("data-status", "stopped");
  await runInTerminal(page, "exit");
  await expect(page.getByTestId("terminal-state")).toHaveText("exited", { timeout: 15_000 });

  await page.getByTestId("preview-start").click();
  await expect(page.locator('[data-wb-term-session] [role="tab"]', { hasText: "dev" })).toHaveCount(2, {
    timeout: 15_000,
  });
  await expect(frame(page).getByRole("heading")).toHaveText("Anchored Dev", { timeout: 15_000 });
});

test("monorepo aligns initial picker with preferred app and preserves chosen app on tab takeover", async ({
  page,
}) => {
  test.skip(TAB_POLICY !== "attach", "tabs share a workspace only with the attach policy");

  const id = await newWorkspace(page);
  await expect.poll(() => page.evaluate(() => globalThis.sprockt?.workspace !== undefined)).toBe(true);
  await page.evaluate((files) => globalThis.sprockt?.workspace?.files.writeMany(files), {
    "package.json": JSON.stringify({ name: "mono", private: true, workspaces: ["apps/*"] }),
    "node_modules/.keep": "",
    "apps/api/package.json": JSON.stringify({ name: "api", scripts: { dev: "bun server.ts -p 3102" } }),
    "apps/api/server.ts": SERVER("Mono API App", 3102),
    "apps/web/package.json": JSON.stringify({
      name: "web",
      scripts: { dev: "bun server.ts -p 3101" },
      devDependencies: { vite: "^6.0.0" },
    }),
    "apps/web/server.ts": SERVER("Mono Web App", 3101),
  });
  await expect(page.getByTestId("save-state")).toHaveText("saved");

  // Options are sorted alphabetically, but Vite web app is preferred so the picker starts on it.
  const targetSelect = page.getByTestId("preview-target-select");
  await expect(targetSelect).toBeVisible();
  await expect(targetSelect.locator("option")).toHaveText(["api · dev", "web · dev"]);
  await expect(targetSelect).toHaveValue("apps/web:dev");

  // Explicitly choose api · dev and start it in tab 1.
  await targetSelect.selectOption("apps/api:dev");
  await page.getByTestId("preview-start").click();
  await expect(frame(page).getByRole("heading")).toHaveText("Mono API App", { timeout: 15_000 });
  await expect(page.getByTestId("wb-preview-port-select")).toHaveValue("3102");

  // Open tab 2 on the same workspace: it follows api · dev, and keeps it after tab 1 closes.
  const second = await page.context().newPage();
  await second.goto(`/w/${id}`);
  await expect(second.getByTestId("terminal-state")).toHaveText("ready", { timeout: 20_000 });
  await expect(second.getByTestId("preview-target-select")).toHaveValue("apps/api:dev", {
    timeout: 15_000,
  });
  await expect(second.getByTestId("wb-preview-port-select")).toHaveValue("3102", { timeout: 15_000 });
  await expect(frame(second).getByRole("heading")).toHaveText("Mono API App", { timeout: 15_000 });

  await page.close();
  await expect(second.getByTestId("preview-task")).toBeEnabled({ timeout: 20_000 });
  await expect(second.getByTestId("preview-task")).toHaveAttribute("data-status", "running", {
    timeout: 20_000,
  });
  await expect(second.getByTestId("preview-target-select")).toHaveValue("apps/api:dev");
  await expect(second.getByTestId("wb-preview-port-select")).toHaveValue("3102", { timeout: 15_000 });
  await expect(frame(second).getByRole("heading")).toHaveText("Mono API App", { timeout: 15_000 });
});

test("picker stays on the running target when background edits promote another app to default", async ({
  page,
}) => {
  await newWorkspace(page);
  await expect.poll(() => page.evaluate(() => globalThis.sprockt?.workspace !== undefined)).toBe(true);
  await page.evaluate((files) => globalThis.sprockt?.workspace?.files.writeMany(files), {
    "package.json": JSON.stringify({ name: "mono", private: true, workspaces: ["apps/*"] }),
    "node_modules/.keep": "",
    "apps/api/package.json": JSON.stringify({ name: "api", scripts: { dev: "bun server.ts -p 3102" } }),
    "apps/api/server.ts": SERVER("Mono API App", 3102),
    "apps/web/package.json": JSON.stringify({ name: "web", scripts: { dev: "bun server.ts -p 3101" } }),
    "apps/web/server.ts": SERVER("Mono Web App", 3101),
  });
  await expect(page.getByTestId("save-state")).toHaveText("saved");

  // Default Start launches api · dev (alphabetically first plain Bun target).
  const targetSelect = page.getByTestId("preview-target-select");
  await expect(targetSelect).toHaveValue("apps/api:dev");
  await page.getByTestId("preview-start").click();
  await expect(frame(page).getByRole("heading")).toHaveText("Mono API App", { timeout: 15_000 });

  // Edit web's package.json so detection promotes web · dev to default while api · dev is running.
  await page.evaluate((files) => globalThis.sprockt?.workspace?.files.writeMany(files), {
    "apps/web/package.json": JSON.stringify({
      name: "web",
      scripts: { dev: "bun server.ts -p 3101" },
      devDependencies: { vite: "^6.0.0" },
    }),
  });
  await expect(page.getByTestId("save-state")).toHaveText("saved");

  // Picker must stay on apps/api:dev so selecting apps/web:dev actually triggers a switch.
  await expect(targetSelect).toHaveValue("apps/api:dev");
  await targetSelect.selectOption("apps/web:dev");
  await expect(frame(page).getByRole("heading")).toHaveText("Mono Web App", { timeout: 15_000 });
  await expect(targetSelect).toHaveValue("apps/web:dev");
});
