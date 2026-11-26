import type { Page } from "@playwright/test";
import { expect, newWorkspace, runInTerminal, terminalText, test, writeFile } from "./helpers";

/** `l2` is `l1/..`: read as text that is the project root; in the filesystem it is /home/guest. */
const LINKS = `
import { symlinkSync } from "node:fs";
symlinkSync("/home/guest/x", "l1");
symlinkSync("l1/..", "l2");
symlinkSync("src", "alias");
symlinkSync("main.ts", "src/link.ts");
console.log("links made");
`;

/** Calls a file service method in the page and reports how it ended. */
function attempt(page: Page, method: "read" | "write" | "remove", path: string): Promise<string> {
  return page.evaluate(
    async ([name, file]) => {
      const files = globalThis.sprockt?.workspace?.files;
      if (!files) return "no workspace";
      try {
        if (name === "write") await files.write(file, "written through the file service\n");
        else if (name === "remove") await files.remove(file);
        else return `read: ${await files.read(file)}`;
        return "done";
      } catch (error) {
        return error instanceof Error ? error.name : String(error);
      }
    },
    [method, path] as const,
  );
}

// These run against Waffle's own path resolution, in the browser: the rule the file service
// enforces is only as good as its agreement with the filesystem that carries out the write.
test("the file service writes into directories that do not exist yet", async ({ page }) => {
  await newWorkspace(page);
  await expect(page.getByTestId("terminal-state")).toHaveText("ready");
  expect(await attempt(page, "write", "src/deep/er/main.ts")).toBe("done");
  expect(await attempt(page, "read", "src/deep/er/main.ts")).toBe("read: written through the file service\n");
  expect(await attempt(page, "read", "not/there/at/all.ts")).toBe("read: undefined");
  await runInTerminal(page, "cat src/deep/er/main.ts");
  await expect.poll(() => terminalText(page)).toMatch(/^written through the file service$/m);
});

test("the file service does not reach outside the project through links", async ({ page }) => {
  // The base programs have no `ln`, so Bun makes the links.
  await newWorkspace(page);
  await runInTerminal(page, "mkdir -p /home/guest/x src && echo private > /home/guest/existing.txt");
  await runInTerminal(page, "echo old > src/main.ts");
  await writeFile(page, "links.ts", LINKS);
  await runInTerminal(page, "bun links.ts");
  await expect.poll(() => terminalText(page)).toMatch(/^links made$/m);

  expect(await attempt(page, "write", "l1/direct.txt")).toBe("ProjectPathError");
  expect(await attempt(page, "write", "l2/escaped.txt")).toBe("ProjectPathError");
  expect(await attempt(page, "write", "l2/existing.txt")).toBe("ProjectPathError");
  expect(await attempt(page, "read", "l2/existing.txt")).toBe("ProjectPathError");
  expect(await attempt(page, "remove", "l2/existing.txt")).toBe("ProjectPathError");

  // A link is never itself read or written, and nothing is created inside one.
  expect(await attempt(page, "read", "src/link.ts")).toBe("ProjectPathError");
  expect(await attempt(page, "write", "alias/new.ts")).toBe("ProjectPathError");

  // A directory link that stays inside the project is followed for a file that exists.
  expect(await attempt(page, "read", "alias/main.ts")).toBe("read: old\n");
  // The link itself can be removed.
  expect(await attempt(page, "remove", "l2")).toBe("done");

  await runInTerminal(page, "clear; ls /home/guest /home/guest/x; cat /home/guest/existing.txt");
  await expect.poll(() => terminalText(page)).toMatch(/^private$/m);
  const listing = await terminalText(page);
  expect(listing).not.toContain("escaped.txt");
  expect(listing).not.toContain("direct.txt");
});
