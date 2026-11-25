import { expect, test } from "bun:test";
import { joinPath } from "../files/paths";
import type { DirEntry } from "../files/tree";
import { createAutoOpener } from "./auto-open";

/** A fake tree: each directory path maps to its entries. Records how the opener used it. */
function tree(directories: Readonly<Record<string, readonly DirEntry[]>>) {
  const stats = { listed: [] as string[], concurrent: 0, peak: 0 };
  const opened: { path: string; size: number }[] = [];
  return {
    stats,
    opened,
    async list(path: string) {
      stats.listed.push(path);
      stats.concurrent += 1;
      stats.peak = Math.max(stats.peak, stats.concurrent);
      await new Promise((resolve) => setTimeout(resolve, 1));
      stats.concurrent -= 1;
      return directories[path];
    },
    open: (path: string, listing: readonly DirEntry[]) => void opened.push({ path, size: listing.length }),
  };
}

const folder = (name: string): DirEntry => ({ name, kind: "directory" });
const file = (name: string): DirEntry => ({ name, kind: "file" });
const files = (count: number): DirEntry[] => Array.from({ length: count }, (_, index) => file(`f${index}`));

test("a small project opens whole, shallow folders first", async () => {
  const fake = tree({
    src: [folder("lib"), file("a.ts")],
    docs: [file("b.md")],
    "src/lib": [folder("deep"), file("c.ts")],
    "src/lib/deep": [file("d.ts")],
  });
  const opener = createAutoOpener({ limit: 300, concurrency: 4, list: fake.list, open: fake.open });
  opener.offer("", [folder("src"), folder("docs"), file("package.json")]);
  await opener.settled();
  expect(fake.opened.map((entry) => entry.path)).toEqual(["src", "docs", "src/lib", "src/lib/deep"]);
});

test("node_modules and .git are never listed or opened", async () => {
  const fake = tree({ src: [file("a.ts")], node_modules: [file("x")], ".git": [file("HEAD")] });
  const opener = createAutoOpener({ limit: 300, concurrency: 4, list: fake.list, open: fake.open });
  opener.offer("", [folder("node_modules"), folder(".git"), folder("src")]);
  await opener.settled();
  expect(fake.stats.listed).toEqual(["src"]);
});

test("280 wide folders of 2,000 files stay within the budget: at most 4 listings at once, none that do not fit", async () => {
  const wide: Record<string, readonly DirEntry[]> = {};
  const root: DirEntry[] = [];
  for (let index = 0; index < 280; index += 1) {
    root.push(folder(`d${index}`));
    wide[`d${index}`] = files(2000);
  }
  const fake = tree(wide);
  const opener = createAutoOpener({ limit: 300, concurrency: 4, list: fake.list, open: fake.open });
  opener.offer("", root);
  await opener.settled();
  // The root alone is 280 of the 300: no 2,000-entry folder fits, so nothing is opened.
  expect(fake.opened).toEqual([]);
  expect(fake.stats.peak).toBeLessThanOrEqual(4);
  // Listing stops at the first folder that does not fit; it does not go on through all 280.
  expect(fake.stats.listed.length).toBeLessThanOrEqual(4);
});

test("the total of everything opened never passes the budget, and opening stops as soon as it is reached", async () => {
  const directories: Record<string, readonly DirEntry[]> = {};
  const root: DirEntry[] = [];
  for (let index = 0; index < 40; index += 1) {
    root.push(folder(`d${index}`));
    directories[`d${index}`] = [...files(9), folder("sub")];
    directories[joinPath(`d${index}`, "sub")] = files(10);
  }
  const fake = tree(directories);
  const opener = createAutoOpener({ limit: 300, concurrency: 4, list: fake.list, open: fake.open });
  opener.offer("", root);
  await opener.settled();
  const total = root.length + fake.opened.reduce((sum, entry) => sum + entry.size, 0);
  expect(total).toBeLessThanOrEqual(300);
  expect(fake.stats.peak).toBeLessThanOrEqual(4);
  // Level by level: every first-level folder that fit opened before any second-level one.
  const firstSecond = fake.opened.findIndex((entry) => entry.path.endsWith("/sub"));
  const lastFirst = fake.opened.findLastIndex((entry) => !entry.path.endsWith("/sub"));
  expect(firstSecond === -1 || lastFirst < firstSecond).toBe(true);
});

test("a refresh of a listing already counted does not use the budget twice, and stop ends everything", async () => {
  const fake = tree({ a: files(100), b: files(100) });
  const opener = createAutoOpener({ limit: 300, concurrency: 4, list: fake.list, open: fake.open });
  for (let round = 0; round < 10; round += 1) opener.offer("", [folder("a"), folder("b")]);
  await opener.settled();
  expect(fake.opened.map((entry) => entry.path)).toEqual(["a", "b"]);

  const later = tree({ c: files(1) });
  const stopped = createAutoOpener({ limit: 300, concurrency: 4, list: later.list, open: later.open });
  stopped.stop();
  stopped.offer("", [folder("c")]);
  await stopped.settled();
  expect(later.stats.listed).toEqual([]);
});
