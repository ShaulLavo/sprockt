import { expect, test } from "bun:test";
import {
  checkForScripts,
  FileChange,
  fileChangeType,
  hasOwnScriptFile,
  isScriptFile,
  isWatchedPath,
  packageNeedsInstall,
  projectRelativeName,
  touchesDependencyState,
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

const rename = (name: string) => ({ type: "rename" as const, name });
const change = (name: string) => ({ type: "change" as const, name });

test("a script file named by an event is found at once", () => {
  expect(
    checkForScripts("/workspace", [change("workspace/README.md"), rename("workspace/src/a.ts")]),
  ).toEqual({
    found: true,
    recheck: [],
  });
});

test("a directory moved or created in the project is listed again, since its files are not named", () => {
  // Moving node_modules/prepared (holding main.ts) to src announces only the two directories.
  const check = checkForScripts("/workspace", [
    rename("workspace/node_modules/prepared"),
    rename("workspace/src"),
  ]);
  expect(check).toEqual({ found: false, recheck: ["/workspace/src"] });
});

test("changes inside dependencies, .git or outside the project need no listing", () => {
  const check = checkForScripts("/workspace", [
    rename("workspace/node_modules/pkg/index.js"),
    rename("workspace/.git/refs"),
    rename("tmp/x"),
    change("workspace/docs"),
  ]);
  expect(check).toEqual({ found: false, recheck: [] });
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

test("packageNeedsInstall detects declared dependencies and devDependencies safely", () => {
  expect(packageNeedsInstall(undefined)).toBe(false);
  expect(packageNeedsInstall("{not json")).toBe(false);
  expect(packageNeedsInstall('{"name":"empty","scripts":{"dev":"bun server.ts"}}')).toBe(false);
  expect(packageNeedsInstall('{"dependencies":{},"devDependencies":{}}')).toBe(false);
  expect(packageNeedsInstall('{"dependencies":{"react":"19.3.1"}}')).toBe(true);
  expect(packageNeedsInstall('{"devDependencies":{"@types/bun":"1.4.5"}}')).toBe(true);
});

test("touchesDependencyState notices package.json and node_modules changes only", () => {
  expect(touchesDependencyState("/workspace", [change("workspace/src/App.tsx")])).toBe(false);
  expect(touchesDependencyState("/workspace", [change("workspace/package.json")])).toBe(true);
  expect(touchesDependencyState("/workspace", [rename("workspace/node_modules")])).toBe(true);
  expect(
    touchesDependencyState("/workspace", [rename("workspace/node_modules/@types/react/index.d.ts")]),
  ).toBe(true);
  expect(touchesDependencyState("/workspace", [change("other/package.json")])).toBe(false);
});
