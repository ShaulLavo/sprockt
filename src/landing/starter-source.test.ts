import { expect, test } from "bun:test";
import { findTemplate } from "../templates/catalog";
import { APP_TSX_LINES, APP_TSX_SOURCE, markLine } from "./starter-source";

test("the landing page shows the Vite + React starter's real App.tsx", () => {
  expect(APP_TSX_SOURCE).toBe(findTemplate("vite-react")?.files["src/App.tsx"] ?? "");
});

test("no line of the shown source is wider than the render's editor", () => {
  const widest = Math.max(...APP_TSX_SOURCE.split("\n").map((line) => line.length));
  expect(widest).toBeLessThanOrEqual(76);
});

test("marking a line keeps every character and records its indent", () => {
  for (const line of APP_TSX_SOURCE.trimEnd().split("\n")) {
    const marked = markLine(line);
    expect(" ".repeat(marked.indent) + marked.tokens.map((token) => token[1]).join("")).toBe(line);
  }
  expect(APP_TSX_LINES).toHaveLength(24);
});

test("keywords, strings, tags, attributes, calls and numbers get their kinds", () => {
  expect(markLine('import { useState } from "react";').tokens).toEqual([
    ["sk", "import"],
    ["", " "],
    ["sp", "{"],
    ["", " useState "],
    ["sp", "}"],
    ["", " "],
    ["sk", "from"],
    ["", " "],
    ["ss", '"react"'],
    ["sp", ";"],
  ]);
  const button = markLine('      <button className="counter" onClick={() => setCount((n) => n + 1)}>');
  expect(button.indent).toBe(6);
  expect(button.tokens).toContainEqual(["stg", "button"]);
  expect(button.tokens).toContainEqual(["sa", "className"]);
  expect(button.tokens).toContainEqual(["sf", "setCount"]);
  expect(button.tokens).toContainEqual(["sn", "1"]);
});
