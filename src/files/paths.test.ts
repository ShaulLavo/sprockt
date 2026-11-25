import { expect, test } from "bun:test";
import {
  ancestorsOf,
  baseName,
  checkName,
  isInside,
  joinPath,
  parentOf,
  rebase,
  safeRelativePath,
} from "./paths";

test("paths join, split and nest", () => {
  expect(joinPath("", "a.ts")).toBe("a.ts");
  expect(joinPath("src", "a.ts")).toBe("src/a.ts");
  expect(parentOf("src/lib/a.ts")).toBe("src/lib");
  expect(parentOf("a.ts")).toBe("");
  expect(baseName("src/lib/a.ts")).toBe("a.ts");
  expect(ancestorsOf("a/b/c.ts")).toEqual(["a", "a/b"]);
  expect(ancestorsOf("c.ts")).toEqual([]);
});

test("inside means below, and a path sharing only a name prefix is not inside", () => {
  expect(isInside("src/a", "src")).toBe(true);
  expect(isInside("src", "src")).toBe(false);
  expect(isInside("srcx/a", "src")).toBe(false);
  expect(isInside("a", "")).toBe(true);
  expect(isInside("", "")).toBe(false);
});

test("moving a directory rebases what is inside it and leaves the rest alone", () => {
  expect(rebase("src", "src", "lib")).toBe("lib");
  expect(rebase("src/a/b.ts", "src", "lib")).toBe("lib/a/b.ts");
  expect(rebase("srcx/a", "src", "lib")).toBe("srcx/a");
  expect(rebase("a.ts", "src", "lib")).toBe("a.ts");
});

test("a name must be non-empty, one path segment, short and unused", () => {
  expect(checkName("", [])).toBe("empty");
  expect(checkName(".", [])).toBe("reserved");
  expect(checkName("..", [])).toBe("reserved");
  expect(checkName("a/b", [])).toBe("separator");
  expect(checkName("a\\b", [])).toBe("separator");
  expect(checkName("a\0b", [])).toBe("separator");
  expect(checkName("x".repeat(256), [])).toBe("too-long");
  expect(checkName("é".repeat(128), [])).toBe("too-long");
  expect(checkName("main.ts", ["main.ts", "a.ts"])).toBe("exists");
  expect(checkName("Main.ts", ["main.ts"])).toBeUndefined();
  expect(checkName(".gitignore", [])).toBeUndefined();
});

test("uploaded paths lose empty and dot segments, and anything that climbs out is refused", () => {
  expect(safeRelativePath("a/b.txt")).toBe("a/b.txt");
  expect(safeRelativePath("/a/b.txt")).toBeUndefined();
  expect(safeRelativePath("/etc/passwd")).toBeUndefined();
  expect(safeRelativePath("a//b.txt")).toBeUndefined();
  expect(safeRelativePath("a/./b.txt")).toBeUndefined();
  expect(safeRelativePath("a/b/")).toBeUndefined();
  expect(safeRelativePath("../a")).toBeUndefined();
  expect(safeRelativePath("a/../../b")).toBeUndefined();
  expect(safeRelativePath("a\\b")).toBeUndefined();
  expect(safeRelativePath("")).toBeUndefined();
  expect(safeRelativePath("./")).toBeUndefined();
});
