import { expect, test } from "bun:test";
import {
  canMoveInto,
  entryRows,
  navigate,
  rangeBetween,
  renameSelection,
  targetDirectory,
  topLevelPaths,
  visibleRows,
  type Listings,
} from "./model";

const listings: Listings = new Map([
  [
    "",
    [
      { name: "src", kind: "directory" as const },
      { name: "empty", kind: "directory" as const },
      { name: "package.json", kind: "file" as const },
    ],
  ],
  [
    "src",
    [
      { name: "lib", kind: "directory" as const },
      { name: "main.ts", kind: "file" as const },
    ],
  ],
]);

const names = (rows: ReturnType<typeof visibleRows>) =>
  rows.map((row) => (row.type === "entry" ? `${row.depth}:${row.path}` : `${row.depth}:+${row.kind}`));

test("only the expanded directories show their children", () => {
  expect(names(visibleRows(listings, new Set()))).toEqual(["0:src", "0:empty", "0:package.json"]);
  expect(names(visibleRows(listings, new Set(["src"])))).toEqual([
    "0:src",
    "1:src/lib",
    "1:src/main.ts",
    "0:empty",
    "0:package.json",
  ]);
});

test("an expanded directory without a listing is loading, and a collapsed one is not", () => {
  const rows = entryRows(visibleRows(listings, new Set(["empty", "src/lib"])));
  expect(rows.find((row) => row.path === "empty")?.loading).toBe(true);
  expect(rows.find((row) => row.path === "src")?.loading).toBe(false);
  expect(rows.find((row) => row.path === "src/lib")).toBeUndefined();
});

test("a new-entry box sits first inside its parent, one level down", () => {
  const rows = visibleRows(listings, new Set(["src"]), { mode: "create", kind: "file", parent: "src" });
  expect(names(rows).slice(0, 3)).toEqual(["0:src", "1:+file", "1:src/lib"]);
  const root = visibleRows(listings, new Set(), { mode: "create", kind: "directory", parent: "" });
  expect(names(root)[0]).toBe("0:+directory");
});

test("a rename marks exactly its own row", () => {
  const rows = entryRows(visibleRows(listings, new Set(["src"]), { mode: "rename", path: "src/main.ts" }));
  expect(rows.filter((row) => row.editing).map((row) => row.path)).toEqual(["src/main.ts"]);
});

const rows = entryRows(visibleRows(listings, new Set(["src"])));

test("arrows move through the visible rows and stop at the ends", () => {
  expect(navigate(rows, "src", "ArrowDown")).toEqual({ focus: "src/lib" });
  expect(navigate(rows, "package.json", "ArrowDown")).toEqual({ focus: "package.json" });
  expect(navigate(rows, "src", "ArrowUp")).toEqual({ focus: "src" });
  expect(navigate(rows, "empty", "Home")).toEqual({ focus: "src" });
  expect(navigate(rows, "src", "End")).toEqual({ focus: "package.json" });
  expect(navigate(rows, undefined, "ArrowDown")).toEqual({ focus: "src" });
});

test("right opens a folder, then enters it; left closes it, then leaves it", () => {
  expect(navigate(rows, "empty", "ArrowRight")).toEqual({ expand: "empty" });
  expect(navigate(rows, "src", "ArrowRight")).toEqual({ focus: "src/lib" });
  expect(navigate(rows, "package.json", "ArrowRight")).toEqual({});
  expect(navigate(rows, "src", "ArrowLeft")).toEqual({ collapse: "src" });
  expect(navigate(rows, "src/main.ts", "ArrowLeft")).toEqual({ focus: "src" });
  expect(navigate(rows, "package.json", "ArrowLeft")).toEqual({});
});

test("shift-click selects the rows between two paths, in either direction", () => {
  expect(rangeBetween(rows, "src", "src/main.ts")).toEqual(["src", "src/lib", "src/main.ts"]);
  expect(rangeBetween(rows, "src/main.ts", "src")).toEqual(["src", "src/lib", "src/main.ts"]);
  expect(rangeBetween(rows, "gone", "src")).toEqual(["src"]);
});

test("moving a folder along with something inside it keeps only the folder", () => {
  expect(topLevelPaths(["a/b", "a", "c", "ab"])).toEqual(["a", "c", "ab"]);
});

test("a drop is refused into itself, into its own subtree and where it already is", () => {
  expect(canMoveInto(["src"], "src")).toBe(false);
  expect(canMoveInto(["src"], "src/lib")).toBe(false);
  expect(canMoveInto(["src/main.ts"], "src")).toBe(false);
  expect(canMoveInto(["package.json"], "")).toBe(false);
  expect(canMoveInto(["package.json"], "src")).toBe(true);
  expect(canMoveInto(["src/main.ts"], "")).toBe(true);
  expect(canMoveInto(["src", "package.json"], "empty")).toBe(true);
  expect(canMoveInto(["src", "empty"], "empty")).toBe(false);
  expect(canMoveInto([], "src")).toBe(false);
  expect(canMoveInto(["srcx"], "src")).toBe(true);
});

test("new entries go into the selected folder, or beside the selected file", () => {
  expect(targetDirectory(undefined, undefined)).toBe("");
  expect(targetDirectory("src", "directory")).toBe("src");
  expect(targetDirectory("src/main.ts", "file")).toBe("src");
  expect(targetDirectory("package.json", "file")).toBe("");
});

test("a rename starts with the name before the last dot selected", () => {
  expect(renameSelection("main.test.ts")).toEqual([0, 9]);
  expect(renameSelection(".gitignore")).toEqual([0, 10]);
  expect(renameSelection("Makefile")).toEqual([0, 8]);
});
