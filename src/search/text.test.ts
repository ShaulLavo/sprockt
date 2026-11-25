import { expect, test } from "bun:test";
import { compileQuery, looksBinary, matchLines, type SearchQuery } from "./text";

const query = (text: string, flags: Partial<SearchQuery> = {}): SearchQuery => ({
  text,
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  ...flags,
});

function find(text: string, search: SearchQuery, limit = 100) {
  const matcher = compileQuery(search);
  if (typeof matcher === "string") throw new Error(matcher);
  return matchLines(text, matcher, limit);
}

test("matches carry 1-based lines and columns and their line as a preview", () => {
  const matches = find("first\nsecond needle\n\nneedle again\n", query("needle"));
  expect(matches.map(({ line, column, preview }) => ({ line, column, preview }))).toEqual([
    { line: 2, column: 8, preview: "second needle" },
    { line: 4, column: 1, preview: "needle again" },
  ]);
});

test("several matches on one line and CRLF line endings", () => {
  const matches = find("a x a\r\nb a\r\n", query("a"));
  expect(matches.map(({ line, column }) => [line, column])).toEqual([
    [1, 1],
    [1, 5],
    [2, 3],
  ]);
  expect(matches[2]?.preview).toBe("b a");
});

test("plain queries are literal; case, whole-word and regex options do what they say", () => {
  expect(find("a.b axb", query("a.b"))).toHaveLength(1);
  expect(find("Foo foo", query("foo", { caseSensitive: true }))).toHaveLength(1);
  expect(find("cat catalog", query("cat", { wholeWord: true }))).toHaveLength(1);
  expect(find("id1 id22", query("id\\d+", { regex: true })).map((match) => match.length)).toEqual([3, 4]);
});

test("an invalid regular expression is reported, not thrown", () => {
  expect(typeof compileQuery(query("(", { regex: true }))).toBe("string");
  expect(typeof compileQuery(query(""))).toBe("string");
});

test("empty matches are skipped and the limit stops the scan", () => {
  expect(find("abc", query("x*", { regex: true }))).toHaveLength(0);
  expect(find("a a a a", query("a"), 2)).toHaveLength(2);
});

test("a long line is cut to a window that still contains the match", () => {
  const line = `${"x".repeat(500)}needle${"y".repeat(500)}`;
  const [match] = find(line, query("needle"));
  expect(match?.preview.length).toBeLessThanOrEqual(200);
  expect(match?.preview.slice(match.previewStart, match.previewStart + 6)).toBe("needle");
  expect(match?.column).toBe(501);
});

test("a NUL byte early in a file marks it as binary", () => {
  expect(looksBinary(new Uint8Array([0x61, 0, 0x62]))).toBe(true);
  expect(looksBinary(new TextEncoder().encode("plain text"))).toBe(false);
});
