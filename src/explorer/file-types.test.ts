import { expect, test } from "bun:test";
import { fileKindOf } from "./file-types";

test("each kind of file gets its own glyph", () => {
  const icons = [
    "a.ts",
    "a.tsx",
    "a.js",
    "a.json",
    "a.css",
    "a.html",
    "a.md",
    "bun.lock",
    ".gitignore",
    "a.png",
    "a.txt",
  ].map((name) => fileKindOf(name).icon);
  expect(new Set(icons).size).toBe(icons.length);
});

test("lock files are recognised by name and by extension, before JSON", () => {
  expect(fileKindOf("package-lock.json").icon).toBe("lock");
  expect(fileKindOf("bun.lock").icon).toBe("lock");
  expect(fileKindOf("Cargo.lock").icon).toBe("lock");
});

test("a leading dot is a dotfile, unless the file has a known extension", () => {
  expect(fileKindOf(".env").icon).toBe("settings");
  expect(fileKindOf(".gitignore").icon).toBe("settings");
  expect(fileKindOf(".eslintrc.json").icon).toBe("braces");
});

test("extensions are matched in any case, and unknown ones are plain files", () => {
  expect(fileKindOf("README.MD").icon).toBe("markdown");
  expect(fileKindOf("vite-env.d.ts").icon).toBe("typescript");
  expect(fileKindOf("Makefile").icon).toBe("file");
  expect(fileKindOf("data.bin").icon).toBe("file");
});
