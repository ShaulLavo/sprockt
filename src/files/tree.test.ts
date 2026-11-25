import { expect, test } from "bun:test";
import { buildTree, isHeavyPath, touchesProject } from "./tree";

test("a change inside the project reaches the explorer, with or without a leading slash", () => {
  expect(touchesProject(["workspace/src/main.ts"])).toBe(true);
  expect(touchesProject(["/workspace/package.json"])).toBe(true);
  expect(touchesProject(["workspace"])).toBe(true);
});

test("a change the watcher cannot name is treated as a project change", () => {
  expect(touchesProject([null])).toBe(true);
});

test("changes outside the project, or inside node_modules and .git, are ignored", () => {
  expect(touchesProject(["bin/bun", "home/guest/.bash_history"])).toBe(false);
  expect(touchesProject(["workspace/node_modules/react/index.js"])).toBe(false);
  expect(touchesProject(["workspace/.git/index"])).toBe(false);
  expect(touchesProject(["workspace-other/file"])).toBe(false);
  expect(touchesProject([])).toBe(false);
});

test("one project path among ignored ones is enough", () => {
  expect(touchesProject(["workspace/node_modules/a", "workspace/src/a.ts"])).toBe(true);
});

test("files become a tree with directories first, each level sorted by name", () => {
  const tree = buildTree(["src/main.ts", "package.json", "src/lib/util.ts", "README.md", "src/app.ts"]);
  expect(tree.map((node) => `${node.kind}:${node.name}`)).toEqual([
    "directory:src",
    "file:package.json",
    "file:README.md",
  ]);
  const src = tree[0];
  expect(src?.children.map((node) => node.path)).toEqual(["src/lib", "src/app.ts", "src/main.ts"]);
  expect(src?.children[0]?.children.map((node) => node.path)).toEqual(["src/lib/util.ts"]);
});

test("a directory listed through several files appears once", () => {
  const tree = buildTree(["a/one", "a/two"]);
  expect(tree).toHaveLength(1);
  expect(tree[0]?.children).toHaveLength(2);
});

test("no files gives an empty tree", () => {
  expect(buildTree([])).toEqual([]);
});

test("node_modules and .git are heavy at any depth, similar names are not", () => {
  expect(isHeavyPath("node_modules/react/index.js")).toBe(true);
  expect(isHeavyPath("packages/app/node_modules/x")).toBe(true);
  expect(isHeavyPath(".git/HEAD")).toBe(true);
  expect(isHeavyPath("src/node_modules.ts")).toBe(false);
  expect(isHeavyPath(".github/workflows/ci.yml")).toBe(false);
});
