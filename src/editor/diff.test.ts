import { expect, test } from "bun:test";
import { replacementBetween } from "./diff";

function apply(before: string, after: string): string {
  const edit = replacementBetween(before, after);
  return edit ? before.slice(0, edit.from) + edit.text + before.slice(edit.to) : before;
}

test("equal texts need no edit", () => {
  expect(replacementBetween("same", "same")).toBeNull();
});

test("the edit covers only the changed span", () => {
  expect(replacementBetween("hello world", "hello brave world")).toEqual({ from: 6, to: 6, text: "brave " });
  expect(replacementBetween("abcdef", "abef")).toEqual({ from: 2, to: 4, text: "" });
  expect(replacementBetween("", "new")).toEqual({ from: 0, to: 0, text: "new" });
  expect(replacementBetween("old", "")).toEqual({ from: 0, to: 3, text: "" });
});

test("repeated characters and overlapping prefix and suffix still produce the right text", () => {
  const cases: [string, string][] = [
    ["aaa", "aaaa"],
    ["aaaa", "aa"],
    ["abab", "ab"],
    ["x\ny\n", "x\nz\ny\n"],
    ["😀a", "😁a"],
    ["a😀", "a😁"],
  ];
  for (const [before, after] of cases) expect(apply(before, after)).toBe(after);
});

test("an edit never starts or ends inside a surrogate pair", () => {
  const edit = replacementBetween("😀", "😁");
  expect(edit).toEqual({ from: 0, to: 2, text: "😁" });
});
