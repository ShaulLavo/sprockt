import { expect, test } from "bun:test";
import { parseSavedTabs, serializeTabs } from "./persist";

test("saved tabs round-trip", () => {
  const saved = {
    tabs: [
      { path: "src/main.ts", preview: false },
      { path: "README.md", preview: true },
    ],
    active: "README.md",
  };
  expect(parseSavedTabs(serializeTabs(saved))).toEqual(saved);
});

test("missing, broken or foreign data starts with no tabs", () => {
  const empty = { tabs: [], active: undefined };
  expect(parseSavedTabs(null)).toEqual(empty);
  expect(parseSavedTabs("{not json")).toEqual(empty);
  expect(parseSavedTabs("42")).toEqual(empty);
  expect(parseSavedTabs('{"tabs":"nope"}')).toEqual(empty);
});

test("malformed and duplicate entries are dropped, and a stale active tab falls back to the first", () => {
  const raw = JSON.stringify({
    tabs: [
      { path: "a", preview: false },
      { path: "" },
      { path: "a", preview: true },
      { path: 3 },
      { path: "b", preview: true, x: 1 },
    ],
    active: "gone",
  });
  expect(parseSavedTabs(raw)).toEqual({
    tabs: [
      { path: "a", preview: false },
      { path: "b", preview: true },
    ],
    active: "a",
  });
});
