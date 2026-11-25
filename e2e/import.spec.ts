import { gzipSync } from "node:zlib";
import type { Page, Route } from "@playwright/test";
import { buildTar, paxBody, type TarFixtureEntry } from "../src/importer/github/tar-writer.ts";
import { encodeShareFragment } from "../src/share/share.ts";
import { createGitHubProxy } from "../worker/github-proxy.ts";
import { expect, test } from "./helpers";

const SHA = "0123456789abcdef0123456789abcdef01234567";

/** A codeload-style archive: a global pax header with the commit, everything under one root. */
function archive(files: Readonly<Record<string, string>>): Buffer {
  const root = "demo-0123456";
  const entries: TarFixtureEntry[] = [
    { path: "pax_global_header", type: "g", bytes: paxBody({ comment: SHA }) },
    { path: `${root}/`, type: "5", mode: 0o775 },
  ];
  const fileEntries = Object.entries(files).map(([path, text]) => ({ path: `${root}/${path}`, bytes: text }));
  return gzipSync(buildTar(entries.concat(fileEntries)));
}

const DEMO = {
  "package.json": JSON.stringify({ name: "demo", scripts: { dev: "vite" }, devDependencies: { vite: "7" } }),
  "src/main.ts": "console.log('demo')\n",
  "apps/web/index.html": "<h1>web</h1>\n",
  "apps/web/src/app.ts": "export const app = 1;\n",
};

interface Mock {
  readonly status?: number;
  readonly json?: unknown;
  readonly body?: Buffer;
  readonly headers?: Record<string, string>;
}

/** Answers `/api/github/*` from a table, so tests never reach GitHub. */
async function mockGitHub(page: Page, table: Record<string, Mock | (() => Mock)>): Promise<string[]> {
  const calls: string[] = [];
  await page.route("**/api/github/**", async (route: Route) => {
    const path = new URL(route.request().url()).pathname.slice("/api/github".length);
    calls.push(path);
    const entry = table[path];
    const mock = typeof entry === "function" ? entry() : entry;
    if (!mock) return route.fulfill({ status: 404, json: { error: "not-found", message: "missing" } });
    if (mock.json !== undefined) {
      return route.fulfill({ status: mock.status ?? 200, json: mock.json, headers: mock.headers });
    }
    return route.fulfill({
      status: mock.status ?? 200,
      body: mock.body,
      headers: { "content-type": "application/gzip", ...mock.headers },
    });
  });
  return calls;
}

const repoInfo = (defaultBranch = "main"): Mock => ({
  json: { owner: "acme", repo: "demo", defaultBranch, sizeKiB: 1 },
});

/** The workspace metadata the importer wrote, read through the debug handle. */
/** The workspace metadata, read from the filesystem root (outside the project) through the debug handle. */
function workspaceMeta(page: Page): Promise<unknown> {
  return page.evaluate(async () => {
    const bytes =
      await globalThis.sprockt?.workspace?.runtime.filesystem.readFile("/.sprockt/workspace.json");
    return bytes ? JSON.parse(new TextDecoder().decode(bytes)) : undefined;
  });
}

async function expectWorkspace(page: Page): Promise<string> {
  await expect(page).toHaveURL(/\/w\/[a-z0-9]+$/);
  await expect(page.getByTestId("save-state")).toHaveText("saved");
  return new URL(page.url()).pathname.slice("/w/".length);
}

test("imports a repository into a new workspace and opens it", async ({ page }) => {
  const calls = await mockGitHub(page, {
    "/repo/acme/demo": repoInfo("trunk"),
    "/archive/acme/demo/trunk": { body: archive(DEMO) },
  });
  await page.goto("/github/acme/demo");
  await expectWorkspace(page);
  const tree = page.getByTestId("file-tree");
  await expect(tree).toContainText("package.json");
  await expect(tree).toContainText("src");
  // The metadata lives on the filesystem root, outside the project the explorer shows.
  await expect(tree).not.toContainText(".sprockt");
  expect(calls).toEqual(["/repo/acme/demo", "/archive/acme/demo/trunk"]);
  expect(await workspaceMeta(page)).toMatchObject({
    name: "demo",
    source: { kind: "github", owner: "acme", repo: "demo", ref: "trunk", subdir: "", commit: SHA },
    detected: { framework: "vite", devScript: "dev", port: 5173 },
  });
  // Back leaves the workspace instead of importing the repository a second time.
  await page.goBack();
  await expect(page).not.toHaveURL(/\/github\//);
});

test("imports only the subfolder of a branch whose name has a slash", async ({ page }) => {
  await mockGitHub(page, {
    "/refs/acme/demo/feature": { json: { branches: ["feature/x"], tags: ["feature"] } },
    "/archive/acme/demo/refs/heads/feature/x": { body: archive(DEMO) },
  });
  await page.goto("/github/acme/demo/tree/feature/x/apps/web");
  await expectWorkspace(page);
  const tree = page.getByTestId("file-tree");
  await expect(tree).toContainText("index.html");
  await expect(tree).not.toContainText("package.json");
  expect(await workspaceMeta(page)).toMatchObject({
    name: "demo/apps/web",
    source: { ref: "feature/x", subdir: "apps/web" },
  });
});

const failures: [string, Mock, string][] = [
  [
    "a missing repository",
    { status: 404, json: { error: "not-found", message: "x" } },
    "Repository not found. Check the owner, name and branch, then try again.",
  ],
  [
    "a private repository",
    { status: 403, json: { error: "private", message: "x" } },
    "Private repositories are not supported. Sprockt can only import public GitHub repos.",
  ],
  [
    "a repository over the size limit",
    { status: 413, json: { error: "too-large", message: "x" } },
    "This repository exceeds the import limit of 100 MiB compressed or 256 MiB unpacked. Try importing a subfolder.",
  ],
];

for (const [name, mock, message] of failures) {
  test(`explains ${name}`, async ({ page }) => {
    await mockGitHub(page, { "/repo/acme/demo": mock });
    await page.goto("/github/acme/demo");
    await expect(page.getByTestId("import-error")).toHaveText(message);
    await expect(page).toHaveURL(/\/github\/acme\/demo$/);
  });
}

test("a rate limit says when to retry, and Try again imports once GitHub answers", async ({ page }) => {
  let limited = true;
  await mockGitHub(page, {
    "/repo/acme/demo": () =>
      limited
        ? {
            status: 429,
            json: { error: "rate-limited", message: "x", retryAfter: 90 },
            headers: { "retry-after": "90" },
          }
        : repoInfo(),
    "/archive/acme/demo/main": { body: archive(DEMO) },
  });
  await page.goto("/github/acme/demo");
  await expect(page.getByTestId("import-error")).toHaveText(
    "GitHub rate limit reached. Try again in 2 minutes.",
  );
  limited = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expectWorkspace(page);
  await expect(page.getByTestId("file-tree")).toContainText("package.json");
});

test("a share link opens the workspace's files in a new workspace", async ({ page, context }) => {
  await mockGitHub(page, {
    "/repo/acme/demo": repoInfo(),
    "/archive/acme/demo/main": { body: archive(DEMO) },
  });
  await page.goto("/github/acme/demo");
  const first = await expectWorkspace(page);
  await page.evaluate(() =>
    globalThis.sprockt?.workspace?.files.write("notes/shared.txt", "from the first tab\n"),
  );
  await expect(page.getByTestId("file-tree")).toContainText("notes");
  await expect(page.getByTestId("save-state")).toHaveText("saved");

  await page.getByTestId("share-button").click();
  const link = await page.getByTestId("share-link").inputValue();
  expect(link).toMatch(/\/s#share=[A-Za-z0-9_-]+$/);

  const second = await context.newPage();
  await second.goto(link);
  const opened = await expectWorkspace(second);
  expect(opened).not.toBe(first);
  await expect(second.getByTestId("file-tree")).toContainText("package.json");
  expect(await second.evaluate(() => globalThis.sprockt?.workspace?.files.read("notes/shared.txt"))).toBe(
    "from the first tab\n",
  );
  expect(await workspaceMeta(second)).toMatchObject({ source: { kind: "share", template: "blank" } });
});

test("a damaged share link says so", async ({ page }) => {
  await page.goto("/s#share=not-a-real-link");
  await expect(page.getByTestId("share-error")).toHaveText("This share link is damaged or incomplete.");
});

test("a new fragment on the share page replaces the damaged one", async ({ page }) => {
  const encoded = await encodeShareFragment({
    templateId: "blank",
    files: [{ path: "hello.txt", bytes: new TextEncoder().encode("hi\n") }],
    deleted: [],
  });
  if (!encoded.ok) throw new Error("the fixture fits in a link");
  await page.goto("/s#share=not-a-real-link");
  await expect(page.getByTestId("share-error")).toBeVisible();
  await page.evaluate((fragment) => {
    location.hash = fragment;
  }, encoded.fragment);
  await expectWorkspace(page);
  await expect(page.getByTestId("file-tree")).toContainText("hello.txt");
});

test("when a workspace cannot start, the boot error shows and nothing throws", async ({
  page,
  pageErrors,
}) => {
  await page.route("**/assets/fs-worker-*.js", (route) => route.abort());
  await page.goto("/w/bootfailcheck");
  await expect(page.getByTestId("boot-error")).toBeVisible();
  await expect(page.getByTestId("share-button")).toHaveCount(0);
  // Leaving the failed workbench tears it down without throwing, and the landing page renders.
  await page.getByRole("button", { name: "Sprockt" }).click();
  await expect(page.getByTestId("new-workspace")).toBeVisible();
  expect(pageErrors.filter((error) => error.startsWith("pageerror"))).toEqual([]);
});

/**
 * A workspace as an import leaves it when a reload cuts it off: its metadata still carries the
 * "importing" marker. Written through the workbench, then the page goes back to the landing list.
 */
async function leaveUnfinishedImport(
  page: Page,
  id: string,
  files: Record<string, string> = {},
): Promise<void> {
  await page.goto(`/w/${id}`);
  await expect(page.getByTestId("save-state")).toHaveText("saved");
  await page.evaluate(
    async ({ partial }) => {
      const meta = {
        name: "demo",
        created: "2026-11-25T00:00:00.000Z",
        state: "importing",
        source: { kind: "github", owner: "acme", repo: "demo", ref: "main", subdir: "" },
      };
      const workspace = globalThis.sprockt?.workspace;
      await workspace?.files.writeMany(partial);
      await workspace?.runtime.filesystem.mkdirp("/.sprockt");
      await workspace?.runtime.filesystem.writeFile("/.sprockt/workspace.json", JSON.stringify(meta));
      await workspace?.runtime.filesystem.flush();
    },
    { partial: files },
  );
  await expect(page.getByTestId("save-state")).toHaveText("saved");
  await page.goto("/");
}

function storedIn(page: Page, id: string): Promise<boolean> {
  return page.evaluate(
    async (name) => (await indexedDB.databases()).some((db) => db.name?.includes(name)),
    `sprockt-${id}`,
  );
}

test("an import a reload cut off stays on the landing page until the visitor deletes it", async ({
  page,
}) => {
  await leaveUnfinishedImport(page, "cutoffdelete");
  // A finished workspace next to it is never marked.
  await page.goto("/w/finishedone");
  await expect(page.getByTestId("save-state")).toHaveText("saved");
  await page.goto("/");

  const row = page.getByTestId("workspace-list").locator("li", { hasText: "cutoffdelete" });
  await expect(row.getByTestId("incomplete-import")).toContainText("Import didn't finish");
  const finished = page.getByTestId("workspace-list").locator("li", { hasText: "finishedone" });
  await expect(finished).toBeVisible();
  await expect(finished.getByTestId("incomplete-import")).toHaveCount(0);

  // Nothing removes it on its own: a reload keeps it.
  await page.reload();
  await expect(row.getByTestId("incomplete-import")).toBeVisible();
  expect(await storedIn(page, "cutoffdelete")).toBe(true);

  // Delete asks first; only the confirmation removes it.
  await row.getByTestId("incomplete-delete").click();
  await expect(row.getByRole("alertdialog")).toContainText("Discard workspace demo?");
  await row.getByTestId("incomplete-confirm-delete").click();
  await expect(row).toHaveCount(0);
  await expect.poll(() => storedIn(page, "cutoffdelete")).toBe(false);
  expect(await storedIn(page, "finishedone")).toBe(true);
});

test("Retry re-imports the recorded source into the same workspace", async ({ page }) => {
  await mockGitHub(page, {
    "/archive/acme/demo/main": { body: archive(DEMO) },
  });
  await leaveUnfinishedImport(page, "cutoffretry", { "half-written.txt": "stale" });
  const row = page.getByTestId("workspace-list").locator("li", { hasText: "cutoffretry" });
  await row.getByTestId("incomplete-retry").click();
  await expect(page).toHaveURL(/\/w\/cutoffretry$/);
  await expect(page.getByTestId("file-tree")).toContainText("package.json");
  await expect(page.getByTestId("file-tree")).not.toContainText("half-written.txt");
  expect(await workspaceMeta(page)).toMatchObject({ name: "demo", source: { owner: "acme" } });
  expect(await workspaceMeta(page)).not.toHaveProperty("state");
});

/** Whether GitHub answers from this machine; the real-repository test needs it. */
async function githubReachable(): Promise<boolean> {
  try {
    const response = await fetch("https://api.github.com/zen", { signal: AbortSignal.timeout(5000) });
    return response.ok;
  } catch {
    return false;
  }
}

test("imports a small real public repository through the proxy code", async ({ page }) => {
  test.skip(!(await githubReachable()), "GitHub is not reachable from this machine");
  // The Worker's proxy runs here in the test process, against the real GitHub.
  const proxy = createGitHubProxy();
  const probe = await proxy(new Request("https://sprockt.dev/api/github/repo/octocat/Hello-World"));
  test.skip(probe.status === 429, "GitHub's unauthenticated API limit is used up on this machine");
  await page.route("**/api/github/**", async (route) => {
    const response = await proxy(new Request(route.request().url()));
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: Buffer.from(await response.arrayBuffer()),
    });
  });
  await page.goto("/github/octocat/Hello-World");
  await expectWorkspace(page);
  await expect(page.getByTestId("file-tree")).toContainText("README");
  expect(await workspaceMeta(page)).toMatchObject({ source: { owner: "octocat", repo: "Hello-World" } });
});
