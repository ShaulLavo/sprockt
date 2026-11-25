import { expect, test } from "bun:test";
import { fuzzyMatch, rankPaths, splitLocation } from "./fuzzy";

test("a trailing :line or :line:column is split off the query", () => {
  expect(splitLocation("main.ts")).toEqual({ text: "main.ts" });
  expect(splitLocation(" main.ts:12 ")).toEqual({ text: "main.ts", line: 12, column: undefined });
  expect(splitLocation("main.ts:12:4")).toEqual({ text: "main.ts", line: 12, column: 4 });
  expect(splitLocation("a:b")).toEqual({ text: "a:b" });
  expect(splitLocation("main.ts:0").line).toBeUndefined();
});

test("characters must appear in order, case-insensitively, ignoring spaces in the query", () => {
  expect(fuzzyMatch("apt", "src/App.tsx")).not.toBeNull();
  expect(fuzzyMatch("APP", "src/app.tsx")).not.toBeNull();
  expect(fuzzyMatch("src app", "src/App.tsx")).not.toBeNull();
  expect(fuzzyMatch("tpa", "src/App.tsx")).toBeNull();
  expect(fuzzyMatch("z", "src/App.tsx")).toBeNull();
});

test("positions point at the matched characters", () => {
  const match = fuzzyMatch("main", "src/main.ts");
  expect(match?.positions).toEqual([4, 5, 6, 7]);
});

test("file-name matches beat directory matches, and exact names come first", () => {
  const paths = ["main/other.ts", "src/domain.ts", "src/main.ts", "src/main.test.ts", "lib/m-a-i-n.ts"];
  const ranked = rankPaths("main", paths, 10).map((match) => match.path);
  expect(ranked[0]).toBe("src/main.ts");
  expect(ranked.indexOf("src/main.test.ts")).toBeLessThan(ranked.indexOf("main/other.ts"));
});

test("word starts outrank scattered matches", () => {
  const ranked = rankPaths("ec", ["src/vector.ts", "src/EditorCanvas.tsx"], 10).map((match) => match.path);
  expect(ranked[0]).toBe("src/EditorCanvas.tsx");
});

test("an empty query keeps every path, shortest first, up to the limit", () => {
  expect(rankPaths("", ["b/long.ts", "a.ts", "c.ts"], 2).map((match) => match.path)).toEqual([
    "a.ts",
    "c.ts",
  ]);
});

test("ranking 10,000 paths finishes", () => {
  const paths = Array.from(
    { length: 10_000 },
    (_, index) => `packages/pkg-${index % 97}/src/module-${index}/index.ts`,
  );
  const started = performance.now();
  const ranked = rankPaths("pkg5mod12idx", paths, 50);
  const elapsed = performance.now() - started;
  expect(ranked.length).toBeGreaterThan(0);
  // A hang cap, not a speed target: tests check outcomes. Measured at about 3 ms on the PC.
  expect(elapsed).toBeLessThan(5_000);
});
