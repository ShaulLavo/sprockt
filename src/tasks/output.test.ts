import { expect, test } from "bun:test";
import { plainOutput } from "./output";

const ESC = "\u001B";

test("colours and styles are removed, the words stay", () => {
  const coloured = `${ESC}[0m${ESC}[2m${ESC}[35m$${ESC}[0m ${ESC}[2m${ESC}[1mbun not-there.ts${ESC}[0m\nerror: Module not found "not-there.ts"`;
  expect(plainOutput(coloured)).toBe('$ bun not-there.ts\nerror: Module not found "not-there.ts"');
});

test("cursor moves, titles and links are removed too", () => {
  expect(plainOutput(`${ESC}[2K${ESC}[1Ginstalling${ESC}[?25l`)).toBe("installing");
  expect(plainOutput(`${ESC}]0;window title\u0007ready`)).toBe("ready");
  expect(plainOutput(`${ESC}]8;;https://example.test${ESC}\\link${ESC}]8;;${ESC}\\`)).toBe("link");
  expect(plainOutput(`${ESC}Mup`)).toBe("up");
});

test("line ends become plain newlines, and ordinary text is untouched", () => {
  expect(plainOutput("one\r\ntwo\rthree\n")).toBe("one\ntwo\nthree\n");
  expect(plainOutput("café [not a sequence] 100%")).toBe("café [not a sequence] 100%");
  expect(plainOutput("")).toBe("");
});
