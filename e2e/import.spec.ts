import { gzipSync } from "node:zlib";
import type { Page, Route } from "@playwright/test";
import { buildTar, paxBody, type TarFixtureEntry } from "../src/importer/github/tar-writer.ts";
import { encodeShareFragment } from "../src/share/share.ts";
import { createGitHubProxy } from "../worker/github-proxy.ts";
import { expect, runInTerminal, terminalText, test } from "./helpers";

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
  await expect(page.getByTestId("workspace-name")).toHaveText("demo");
  await expect(page.getByTestId("explorer-workspace-name")).toHaveText("demo");
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
  await expect(page.getByTestId("workspace-name")).toHaveText("web");
  await expect(page.getByTestId("explorer-workspace-name")).toHaveText("web");
  const tree = page.getByTestId("file-tree");
  await expect(tree).toContainText("index.html");
  await expect(tree).not.toContainText("package.json");
  expect(await workspaceMeta(page)).toMatchObject({
    name: "web",
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
  await expect(second.getByTestId("workspace-name")).toHaveText("demo");
  await expect(second.getByTestId("explorer-workspace-name")).toHaveText("demo");
  await expect(second.getByTestId("file-tree")).toContainText("package.json");
  expect(await second.evaluate(() => globalThis.sprockt?.workspace?.files.read("notes/shared.txt"))).toBe(
    "from the first tab\n",
  );
  expect(await workspaceMeta(second)).toMatchObject({
    name: "demo",
    source: { kind: "share", template: "blank" },
  });
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
  await expect(row.getByTestId("incomplete-import")).toContainText("Import did not finish");
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

test("imports a repository with 1,500 files without exhausting Waffle's filesystem request quota", async ({
  page,
}) => {
  const largeRepo: Record<string, string> = {
    "package.json": JSON.stringify({ name: "large-repo" }),
    "README.md": "# Large Repo\n",
  };
  for (let index = 0; index < 1498; index += 1) {
    largeRepo[`packages/pkg-${Math.floor(index / 50)}/file-${index}.ts`] = `export const id = ${index};\n`;
  }
  await mockGitHub(page, {
    "/repo/acme/large-repo": {
      json: { owner: "acme", repo: "large-repo", defaultBranch: "main", sizeKiB: 512 },
    },
    "/archive/acme/large-repo/main": { body: archive(largeRepo) },
  });
  await page.goto("/github/acme/large-repo");
  await expectWorkspace(page);
  await expect(page.getByTestId("file-tree")).toContainText("package.json");
  const files = await page.evaluate(() => globalThis.sprockt?.workspace?.files.list());
  expect(files).toHaveLength(1500);
  expect(files).toContain("packages/pkg-0/file-0.ts");
  expect(files).toContain("packages/pkg-29/file-1497.ts");
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
  // GitHub's unauthenticated limit is shared by every job on a CI runner's address, and it can
  // run out partway through the import. That, or GitHub failing, is not a Sprockt failure.
  const trouble: string[] = [];
  await page.route("**/api/github/**", async (route) => {
    const response = await proxy(new Request(route.request().url())).catch((error: unknown) => {
      trouble.push(`network error: ${String(error)}`);
      return undefined;
    });
    if (!response) return route.abort();
    if (response.status === 429 || response.status >= 500) trouble.push(`HTTP ${response.status}`);
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: Buffer.from(await response.arrayBuffer()),
    });
  });
  await page.goto("/github/octocat/Hello-World");
  await expect
    .poll(() => trouble.length > 0 || /\/w\/[a-z0-9]+$/.test(new URL(page.url()).pathname))
    .toBe(true);
  test.skip(trouble.length > 0, `GitHub did not serve the import: ${trouble.join(", ")}`);
  await expectWorkspace(page);
  await expect(page.getByTestId("file-tree")).toContainText("README");
  await expect(page.getByTestId("workspace-name")).toHaveText("Hello-World");
  await expect(page.getByTestId("explorer-workspace-name")).toHaveText("Hello-World");
  expect(await workspaceMeta(page)).toMatchObject({
    name: "Hello-World",
    source: { owner: "octocat", repo: "Hello-World" },
  });
});

test("hydrates project names for existing workspaces without localStorage hints", async ({ page }) => {
  await mockGitHub(page, {
    "/repo/acme/demo": repoInfo(),
    "/archive/acme/demo/main": { body: archive(DEMO) },
  });
  await page.goto("/github/acme/demo");
  const id = await expectWorkspace(page);
  await expect(page.getByTestId("workspace-name")).toHaveText("demo");

  // Simulate an existing workspace whose browser has no localStorage hint at all, and record
  // every title shown on the boot card so we verify hydration updates BootProgress before boot ends.
  await page.evaluate(() => localStorage.clear());
  await page.addInitScript(() => {
    const titles: string[] = [];
    (globalThis as Record<string, unknown>).bootCardTitles = titles;
    const record = () => {
      const text = document.querySelector('[data-testid="boot-progress"] .wb-boot-title')?.textContent;
      if (text && titles.at(-1) !== text) titles.push(text);
    };
    const observer = new MutationObserver(record);
    observer.observe(document, { childList: true, subtree: true, characterData: true });
  });
  await page.goto(`/w/${id}`);
  await expect(page.getByTestId("save-state")).toHaveText("saved");
  await expect(page.getByTestId("workspace-name")).toHaveText("demo");
  await expect(page.getByTestId("explorer-workspace-name")).toHaveText("demo");
  expect(
    await page.evaluate(() => (globalThis as Record<string, unknown>).bootCardTitles as string[]),
  ).toContain("demo");

  // An existing workspace with no workspace.json hydrates from its root package.json.
  await page.goto("/w/legacyproj");
  await expect(page.getByTestId("save-state")).toHaveText("saved");
  await page.evaluate(async () => {
    const workspace = globalThis.sprockt?.workspace;
    await workspace?.files.write("package.json", JSON.stringify({ name: "hydrated-pkg" }));
    await workspace?.runtime.filesystem.flush();
    localStorage.clear();
  });
  await expect(page.getByTestId("save-state")).toHaveText("saved");
  await page.reload();
  await expect(page.getByTestId("save-state")).toHaveText("saved");
  await expect(page.getByTestId("workspace-name")).toHaveText("hydrated-pkg");
  await expect(page.getByTestId("explorer-workspace-name")).toHaveText("hydrated-pkg");
  expect(
    await page.evaluate(() => (globalThis as Record<string, unknown>).bootCardTitles as string[]),
  ).toContain("hydrated-pkg");
});

/** A valid npm `.tgz` tarball (`package/...`), as published on GitHub Releases. */
function npmTarball(files: Readonly<Record<string, string>>): Buffer {
  const entries: TarFixtureEntry[] = Object.entries(files).map(([path, text]) => ({
    path: `package/${path}`,
    bytes: text,
  }));
  return gzipSync(buildTar(entries));
}

test("bun install fetches public GitHub Release .tgz dependencies through the same-origin proxy", async ({
  page,
}) => {
  const releaseTarball = npmTarball({
    "package.json": JSON.stringify({ name: "release-demo", version: "1.0.0", main: "index.js" }),
    "index.js": 'module.exports = { greeting: "hello-from-release-tgz" };\n',
  });
  const releaseUrl = "https://github.com/acme/release-demo/releases/download/v1.0.0/release-demo-1.0.0.tgz";
  const cdnUrl =
    "https://release-assets.githubusercontent.com/github-production-release-asset/42/asset-id?sp=r&sig=ok";

  const proxyUpstreamCalls: string[] = [];
  const proxy = createGitHubProxy({
    fetch: async (url) => {
      proxyUpstreamCalls.push(url);
      if (url === releaseUrl) {
        return new Response(null, { status: 302, headers: { location: cdnUrl } });
      }
      if (url === cdnUrl) {
        return new Response(new Uint8Array(releaseTarball), {
          status: 200,
          headers: {
            "content-type": "application/octet-stream",
            "content-length": String(releaseTarball.byteLength),
          },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });

  const proxiedPaths: string[] = [];
  const directGitHubRequests: string[] = [];
  await page.route("https://github.com/**", (route) => {
    directGitHubRequests.push(route.request().url());
    return route.abort();
  });
  await page.route("https://release-assets.githubusercontent.com/**", (route) => {
    directGitHubRequests.push(route.request().url());
    return route.abort();
  });
  await page.route("**/api/github/**", async (route) => {
    const reqUrl = route.request().url();
    proxiedPaths.push(new URL(reqUrl).pathname);
    const response = await proxy(new Request(reqUrl, { method: route.request().method() }));
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: Buffer.from(await response.arrayBuffer()),
    });
  });

  await page.goto("/w/reltgztest");
  await expect(page.getByTestId("save-state")).toHaveText("saved");
  await page.evaluate(async (depUrl) => {
    await globalThis.sprockt?.workspace?.files.write(
      "package.json",
      JSON.stringify({ name: "rel-consumer", dependencies: { "release-demo": depUrl } }, null, 2),
    );
    await globalThis.sprockt?.workspace?.runtime.filesystem.flush();
  }, releaseUrl);
  await expect(page.getByTestId("save-state")).toHaveText("saved");

  await runInTerminal(page, `bun install && bun -e 'console.log(require("release-demo").greeting)'`);
  await expect.poll(() => terminalText(page)).toContain("hello-from-release-tgz");
  expect(directGitHubRequests).toEqual([]);
  expect(proxiedPaths).toContain("/api/github/release/acme/release-demo/v1.0.0/release-demo-1.0.0.tgz");
  expect(proxyUpstreamCalls).toEqual([releaseUrl, cdnUrl]);
});

test("uploaded folder name survives leaving and reopening even while another tab holds the naming lock", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await page.getByTestId("template-blank").click();
  const id = await expectWorkspace(page);
  await expect(page.getByTestId("workspace-name")).toHaveText("workspace");

  // Hold the per-workspace naming Web Lock in a second tab during upload and leave.
  const locker = await context.newPage();
  await locker.goto("/");
  await locker.evaluate(async (workspaceId) => {
    await new Promise<void>((acquired) => {
      void navigator.locks.request(`sprockt:${workspaceId}:meta-name`, () => {
        acquired();
        return new Promise<void>((release) => {
          (globalThis as Record<string, unknown>).releaseMetaLock = release;
        });
      });
    });
  }, id);

  try {
    await page.getByTestId("upload-folder-input").evaluate((element: HTMLInputElement) => {
      const transfer = new DataTransfer();
      const file = new File(["export const ok = 1;\n"], "index.ts", { type: "text/plain" });
      transfer.items.add(file);
      element.files = transfer.files;
      const uploaded = element.files[0];
      if (uploaded) {
        Object.defineProperty(uploaded, "webkitRelativePath", { value: "named-folder/index.ts" });
      }
      element.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await expect(page.getByTestId("file-tree")).toContainText("named-folder");
    await expect(page.getByTestId("save-state")).toHaveText("saved");

    // Leave the workspace while the lock is still held.
    await page.goto("/");
    await expect(page.getByTestId("template-blank")).toBeVisible();
  } finally {
    await locker
      .evaluate(() => {
        const release = (globalThis as Record<string, unknown>).releaseMetaLock;
        if (typeof release === "function") release();
      })
      .catch(() => undefined);
    await locker.close();
  }

  // Reopen once the lock is released: the uploaded folder name is applied and persisted.
  await page.goto(`/w/${id}`);
  await expect(page.getByTestId("save-state")).toHaveText("saved");
  await expect(page.getByTestId("workspace-name")).toHaveText("named-folder");
  await expect(page.getByTestId("explorer-workspace-name")).toHaveText("named-folder");
  await expect.poll(() => workspaceMeta(page)).toMatchObject({ name: "named-folder" });
});
