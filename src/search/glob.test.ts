import { expect, test } from "bun:test";
import { compileGlobs } from "./glob";

test("an empty list is no filter at all", () => {
  expect(compileGlobs("")).toBeNull();
  expect(compileGlobs(" , ")).toBeNull();
});

test("a glob without a slash matches any file or directory name", () => {
  const filter = compileGlobs("*.css, dist");
  expect(filter?.("src/app.css")).toBe(true);
  expect(filter?.("app.css")).toBe(true);
  expect(filter?.("packages/web/dist/index.js")).toBe(true);
  expect(filter?.("src/app.ts")).toBe(false);
  expect(filter?.("src/distance.ts")).toBe(false);
});

test("a glob with a slash matches from the root and covers a directory's contents", () => {
  const filter = compileGlobs("src/lib, ./docs/*.md");
  expect(filter?.("src/lib/a.ts")).toBe(true);
  expect(filter?.("src/lib")).toBe(true);
  expect(filter?.("other/src/lib/a.ts")).toBe(false);
  expect(filter?.("docs/intro.md")).toBe(true);
  expect(filter?.("docs/deep/intro.md")).toBe(false);
});

test("** crosses directories while * and ? stay inside one segment", () => {
  const filter = compileGlobs("src/**/*.test.ts");
  expect(filter?.("src/a.test.ts")).toBe(true);
  expect(filter?.("src/x/y/a.test.ts")).toBe(true);
  expect(filter?.("lib/a.test.ts")).toBe(false);
  expect(compileGlobs("a?.ts")?.("ab.ts")).toBe(true);
  expect(compileGlobs("a?.ts")?.("a/.ts")).toBe(false);
});

test("regex characters in a glob are literal", () => {
  const filter = compileGlobs("(x)+.ts");
  expect(filter?.("(x)+.ts")).toBe(true);
  expect(filter?.("xx.ts")).toBe(false);
});
