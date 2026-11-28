import { expect, test } from "bun:test";
import { nestingSuppressions } from "./check-nesting-suppressions";

test.each([
  "// oxlint-disable-next-line no-nested-ternary, unicorn/no-nested-ternary",
  "// oxlint-disable-next-line no-nested-ternary unicorn/no-nested-ternary no-console",
  "/* eslint-disable eslint/max-depth */",
  "/* oxlint-disable-next-line\n  no-await-in-loop, no-else-return */",
  "// eslint-disable-line -- disable everything",
  "/* oxlint-disable ---- suppress all */",
  "/* oxlint-disable --reason */",
])("rejects a directive that can suppress a nesting rule: %s", (comment) => {
  const source = `export const a = 0;\n${comment}\n`;
  expect(nestingSuppressions("fixture.ts", source)).toEqual(["fixture.ts:2"]);
});

test("ignores unrelated disable directives, reasons, and strings", () => {
  const source = `
// oxlint-disable-next-line no-await-in-loop -- max-depth still applies
export const example = "// eslint-disable-next-line max-depth";
`;
  expect(nestingSuppressions("fixture.ts", source)).toEqual([]);
});
