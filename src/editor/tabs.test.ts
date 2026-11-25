import { expect, test } from "bun:test";
import { closeTab, moveTab, openTab, pinTab, renamedPath, renameTabs, type EditorTab } from "./tabs";

const pinned = (...paths: string[]): EditorTab[] => paths.map((path) => ({ path, preview: false }));
const paths = (tabs: readonly EditorTab[]) => tabs.map((tab) => tab.path);

test("a new tab opens after the active one, or at the end without one", () => {
  const tabs = pinned("a", "b", "c");
  expect(paths(openTab(tabs, "d", { preview: false, after: "a" }))).toEqual(["a", "d", "b", "c"]);
  expect(paths(openTab(tabs, "d", { preview: false }))).toEqual(["a", "b", "c", "d"]);
  expect(paths(openTab(tabs, "d", { preview: false, after: "gone" }))).toEqual(["a", "b", "c", "d"]);
});

test("opening a tab that is already open keeps the list, and a pinned open pins a preview", () => {
  const tabs: EditorTab[] = [{ path: "a", preview: true }, ...pinned("b")];
  expect(openTab(tabs, "b", { preview: false })).toEqual(tabs);
  expect(openTab(tabs, "a", { preview: true })).toEqual(tabs);
  expect(openTab(tabs, "a", { preview: false })[0]).toEqual({ path: "a", preview: false });
});

test("a preview replaces the previous preview in place", () => {
  const tabs: EditorTab[] = [...pinned("a"), { path: "p", preview: true }, ...pinned("b")];
  const next = openTab(tabs, "q", { preview: true, after: "b" });
  expect(next).toEqual([...pinned("a"), { path: "q", preview: true }, ...pinned("b")]);
});

test("pinning turns only the named preview into a normal tab", () => {
  const tabs: EditorTab[] = [{ path: "a", preview: true }, ...pinned("b")];
  expect(pinTab(tabs, "a")).toEqual(pinned("a", "b"));
  expect(pinTab(tabs, "b")).toEqual(tabs);
});

test("closing the active tab activates its right neighbour, then its left one", () => {
  const tabs = pinned("a", "b", "c");
  expect(closeTab(tabs, "b", "b")).toEqual({ tabs: pinned("a", "c"), active: "c" });
  expect(closeTab(tabs, "c", "c")).toEqual({ tabs: pinned("a", "b"), active: "b" });
  expect(closeTab(pinned("a"), "a", "a")).toEqual({ tabs: [], active: undefined });
});

test("closing another tab keeps the active one, and closing an unknown path changes nothing", () => {
  const tabs = pinned("a", "b", "c");
  expect(closeTab(tabs, "a", "c")).toEqual({ tabs: pinned("b", "c"), active: "c" });
  expect(closeTab(tabs, "x", "c")).toEqual({ tabs, active: "c" });
});

test("moving a tab puts it at the target index, clamped to the list", () => {
  const tabs = pinned("a", "b", "c", "d");
  expect(paths(moveTab(tabs, 0, 2))).toEqual(["b", "c", "a", "d"]);
  expect(paths(moveTab(tabs, 3, 0))).toEqual(["d", "a", "b", "c"]);
  expect(paths(moveTab(tabs, 1, 99))).toEqual(["a", "c", "d", "b"]);
  expect(paths(moveTab(tabs, 9, 0))).toEqual(["a", "b", "c", "d"]);
});

test("a rename follows a file and everything under a moved directory, not lookalike names", () => {
  expect(renamedPath("src/a.ts", "src/a.ts", "lib/a.ts")).toBe("lib/a.ts");
  expect(renamedPath("src/x/a.ts", "src", "lib")).toBe("lib/x/a.ts");
  expect(renamedPath("srcs/a.ts", "src", "lib")).toBe("srcs/a.ts");
  const tabs = pinned("src/a.ts", "lib/a.ts", "README.md");
  expect(paths(renameTabs(tabs, "src", "lib"))).toEqual(["lib/a.ts", "README.md"]);
});
