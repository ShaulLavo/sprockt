import { expect, test } from "bun:test";
import {
  canMoveInto,
  entryRows,
  filterRows,
  navigate,
  rangeBetween,
  renameSelection,
  splitFilename,
  stickyAncestors,
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

test("single-child expanded directory chains compact onto one row unless a draft targets them", () => {
  const chain: Listings = new Map([
    ["", [{ name: "src", kind: "directory" }]],
    ["src", [{ name: "app", kind: "directory" }]],
    ["src/app", [{ name: "ui", kind: "directory" }]],
    ["src/app/ui", [{ name: "Button.tsx", kind: "file" }]],
  ]);
  const open = new Set(["src", "src/app", "src/app/ui"]);
  const compacted = entryRows(visibleRows(chain, open));
  expect(compacted.map((row) => `${row.depth}:${row.path}`)).toEqual([
    "0:src/app/ui",
    "1:src/app/ui/Button.tsx",
  ]);
  expect(compacted[0]?.segments).toEqual([
    { name: "src", path: "src" },
    { name: "app", path: "src/app" },
    { name: "ui", path: "src/app/ui" },
  ]);
  expect(navigate(compacted, "src/app/ui", "ArrowLeft")).toEqual({ collapse: "src" });
  expect(navigate(compacted, "src/app/ui/Button.tsx", "ArrowLeft")).toEqual({ focus: "src/app/ui" });

  // Creating inside an intermediate folder stops compaction at that folder.
  const withDraft = visibleRows(chain, open, { mode: "create", kind: "file", parent: "src/app" });
  expect(names(withDraft)).toEqual(["0:src/app", "1:+file", "1:src/app/ui", "2:src/app/ui/Button.tsx"]);
});

test("splitFilename preserves simple and compound extensions for middle truncation", () => {
  expect(splitFilename("WorkspaceSettingsPanel.test.tsx")).toEqual({
    stem: "WorkspaceSettingsPanel",
    ext: ".test.tsx",
  });
  expect(splitFilename("env.d.ts")).toEqual({ stem: "env", ext: ".d.ts" });
  expect(splitFilename("App.tsx")).toEqual({ stem: "App", ext: ".tsx" });
  expect(splitFilename(".gitignore")).toEqual({ stem: ".gitignore", ext: "" });
  expect(splitFilename("Makefile")).toEqual({ stem: "Makefile", ext: "" });
});

test("filterRows keeps matching files and marks context-only ancestor folders", () => {
  const filtered = filterRows(["src/app/Button.tsx", "src/main.ts", "README.md"], "button", listings);
  expect(filtered.map((row) => `${row.depth}:${row.path}:${row.contextOnly ? "ctx" : "match"}`)).toEqual([
    "0:src:ctx",
    "1:src/app:ctx",
    "2:src/app/Button.tsx:match",
  ]);
  const folderMatch = filterRows(["src/app/Button.tsx"], "app", listings);
  expect(folderMatch.map((row) => `${row.path}:${row.contextOnly ? "ctx" : "match"}`)).toEqual([
    "src:ctx",
    "src/app:match",
    "src/app/Button.tsx:match",
  ]);
});

test("stickyAncestors returns scrolled-past open parent folders in order", () => {
  const deep: Listings = new Map([
    ["", [{ name: "a", kind: "directory" }]],
    [
      "a",
      [
        { name: "b", kind: "directory" },
        { name: "a.ts", kind: "file" },
      ],
    ],
    [
      "a/b",
      [
        { name: "one.ts", kind: "file" },
        { name: "two.ts", kind: "file" },
      ],
    ],
  ]);
  const all = entryRows(visibleRows(deep, new Set(["a", "a/b"])));
  expect(stickyAncestors(all, 3).map((row) => row.path)).toEqual(["a", "a/b"]);
  expect(stickyAncestors(all, 0)).toEqual([]);
});
