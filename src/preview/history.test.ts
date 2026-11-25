import { expect, test } from "bun:test";
import { canGoBack, canGoForward, currentPath, emptyHistory, stepped, visited } from "./history";

const visit = (paths: readonly string[]) => paths.reduce(visited, emptyHistory);

test("nothing has been visited at first", () => {
  expect(currentPath(emptyHistory)).toBeUndefined();
  expect(canGoBack(emptyHistory)).toBe(false);
  expect(canGoForward(emptyHistory)).toBe(false);
  expect(stepped(emptyHistory, -1)).toBe(emptyHistory);
});

test("each new place is added, and going back and forward moves along the list", () => {
  const history = visit(["/", "/about", "/contact"]);
  expect(currentPath(history)).toBe("/contact");
  expect(canGoForward(history)).toBe(false);

  const back = stepped(history, -1);
  expect(currentPath(back)).toBe("/about");
  expect(canGoBack(back)).toBe(true);
  expect(canGoForward(back)).toBe(true);
  expect(currentPath(stepped(back, 1))).toBe("/contact");
});

test("arriving where the list already points changes nothing: a reload, or the end of a step", () => {
  const history = stepped(visit(["/", "/about"]), -1);
  expect(visited(history, "/")).toBe(history);
});

test("a new place after going back replaces what lay ahead", () => {
  const history = visited(stepped(visit(["/", "/about", "/contact"]), -1), "/pricing");
  expect(history.entries).toEqual(["/", "/about", "/pricing"]);
  expect(canGoForward(history)).toBe(false);
});

test("stepping never leaves the list", () => {
  const history = visit(["/"]);
  expect(stepped(history, -1)).toBe(history);
  expect(stepped(history, 1)).toBe(history);
});
