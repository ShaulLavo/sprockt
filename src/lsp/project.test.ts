import { expect, test } from "bun:test";
import {
  FileChange,
  fileChangeType,
  hasOwnScriptFile,
  isScriptFile,
  isWatchedPath,
  projectRelativeName,
} from "./project";

test("TypeScript and JavaScript sources of every flavour are script files", () => {
  for (const name of ["a.ts", "a.tsx", "a.js", "a.jsx", "a.mts", "a.cts", "a.mjs", "a.cjs", "x/y.d.ts"]) {
    expect(isScriptFile(name)).toBe(true);
  }
  for (const name of ["a.json", "README.md", "ts", "a.tsx.bak", "style.css"])
    expect(isScriptFile(name)).toBe(false);
});

test("only the project's own sources start a server, not dependencies or .git", () => {
  expect(hasOwnScriptFile(["README.md", "src/main.ts"])).toBe(true);
  expect(hasOwnScriptFile(["README.md", "node_modules/pkg/index.js", ".git/hooks/x.js"])).toBe(false);
  expect(hasOwnScriptFile([])).toBe(false);
});

test("watch names are made project-relative, and names outside the project are dropped", () => {
  expect(projectRelativeName("/workspace", "workspace/src/a.ts")).toBe("src/a.ts");
  expect(projectRelativeName("/workspace", "workspace")).toBeUndefined();
  expect(projectRelativeName("/workspace", "workspace/")).toBeUndefined();
  expect(projectRelativeName("/workspace", "workspaces/a.ts")).toBeUndefined();
  expect(projectRelativeName("/workspace", ".sprockt/workspace.json")).toBeUndefined();
});

test("a watch event becomes created, changed or deleted by whether the path exists now", () => {
  expect(fileChangeType("rename", true)).toBe(FileChange.created);
  expect(fileChangeType("change", true)).toBe(FileChange.changed);
  expect(fileChangeType("rename", false)).toBe(FileChange.deleted);
  expect(fileChangeType("change", false)).toBe(FileChange.deleted);
});

test("dependencies are watched, version control is not", () => {
  expect(isWatchedPath("node_modules/pkg/index.d.ts")).toBe(true);
  expect(isWatchedPath("src/a.ts")).toBe(true);
  expect(isWatchedPath(".git/index")).toBe(false);
  expect(isWatchedPath("sub/.git/HEAD")).toBe(false);
});
