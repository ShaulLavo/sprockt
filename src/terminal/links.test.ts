import { describe, expect, test } from "bun:test";
import { parseTerminalFileLinks, safeExternalUrl } from "./links";

describe("safeExternalUrl", () => {
  test("allows http and https URLs and rejects non-web schemes", () => {
    expect(safeExternalUrl("https://sprockt.dev/docs?a=1")).toBe("https://sprockt.dev/docs?a=1");
    expect(safeExternalUrl("http://localhost:5173/")).toBe("http://localhost:5173/");
    expect(safeExternalUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeExternalUrl("data:text/html,<h1>hi</h1>")).toBeUndefined();
    expect(safeExternalUrl("file:///etc/passwd")).toBeUndefined();
    expect(safeExternalUrl("mailto:test@example.com")).toBeUndefined();
    expect(safeExternalUrl("not a url")).toBeUndefined();
  });
});

describe("parseTerminalFileLinks", () => {
  test("parses relative, dotted, and workspace-absolute paths with line and column", () => {
    const line = "ERROR:src/App.tsx:12:4 and (./src/main.ts:8) plus /workspace/src/utils.ts(42,9).";
    expect(parseTerminalFileLinks(line)).toEqual([
      { start: 6, end: 22, path: "src/App.tsx", line: 12, column: 4 },
      { start: 28, end: 43, path: "src/main.ts", line: 8, column: undefined },
      { start: 50, end: 79, path: "src/utils.ts", line: 42, column: 9 },
    ]);
  });

  test("ignores URLs, versions, and bare words", () => {
    const line = "Server ready at https://localhost:5173/src/App.tsx using node/v22.1.0 in 14ms";
    expect(parseTerminalFileLinks(line)).toEqual([]);
  });

  test("handles quoted paths and trailing punctuation", () => {
    const line = "Checking \"package.json\", Makefile; and 'src/index.css': done.";
    expect(parseTerminalFileLinks(line).map((item) => item.path)).toEqual([
      "package.json",
      "Makefile",
      "src/index.css",
    ]);
  });
});
