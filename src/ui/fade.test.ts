import { expect, test } from "bun:test";
import { fadeEdges } from "./fade";

test("only edges with content past them fade", () => {
  expect(fadeEdges(0, 300, 300)).toBe("");
  expect(fadeEdges(0, 500, 300)).toBe("end");
  expect(fadeEdges(100, 500, 300)).toBe("start end");
  expect(fadeEdges(200, 500, 300)).toBe("start");
  // Sub-pixel scroll positions on high-density screens do not leave a stray fade.
  expect(fadeEdges(199.5, 500, 300)).toBe("start");
});
