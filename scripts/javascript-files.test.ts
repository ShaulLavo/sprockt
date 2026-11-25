import { expect, test } from "bun:test";
import { handWrittenJavaScript } from "./javascript-files";

test("JavaScript files of every extension are reported", () => {
  const tracked = ["src/a.ts", "src/b.js", "scripts/c.mjs", "d.cjs", "src/e.jsx", "src/f.tsx"];
  expect(handWrittenJavaScript(tracked, [])).toEqual(["src/b.js", "scripts/c.mjs", "d.cjs", "src/e.jsx"]);
});

test("files under an allowed prefix are not reported", () => {
  const tracked = ["e2e/fixtures/input.js", "src/b.js"];
  expect(handWrittenJavaScript(tracked, ["e2e/fixtures/"])).toEqual(["src/b.js"]);
});

test("names that only contain a JavaScript extension are fine", () => {
  expect(handWrittenJavaScript(["src/js.ts", "docs/notes.js.md", "data.json"], [])).toEqual([]);
});
