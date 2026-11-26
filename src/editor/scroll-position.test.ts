import { describe, expect, test } from "bun:test";
import { capOverscrollTop, clampRestoredScroll, minimalTabScrollLeft } from "./scroll-position";
import { adjacentTab, tabsToClose } from "./tabs";

describe("capOverscrollTop", () => {
  test("clamps saved scroll positions inside the document's non-overscroll range", () => {
    expect(capOverscrollTop(1200, 1000, 400)).toBe(600);
    expect(capOverscrollTop(250, 1000, 400)).toBe(250);
    expect(capOverscrollTop(50, 200, 400)).toBe(0);
    expect(capOverscrollTop(-10, 1000, 400)).toBe(0);
  });

  test("preserves horizontal offset while capping vertical overscroll", () => {
    expect(clampRestoredScroll({ top: 900, left: 48 }, 800, 300)).toEqual({ top: 500, left: 48 });
    expect(clampRestoredScroll(undefined, 800, 300)).toBeUndefined();
  });
});

describe("minimalTabScrollLeft", () => {
  test("leaves already-visible tabs alone and nudges hidden edges past the fade gutter", () => {
    expect(
      minimalTabScrollLeft({ scrollLeft: 100, clientWidth: 400, tabLeft: 150, tabWidth: 120, gutter: 28 }),
    ).toBe(100);
    expect(
      minimalTabScrollLeft({ scrollLeft: 200, clientWidth: 400, tabLeft: 180, tabWidth: 100, gutter: 28 }),
    ).toBe(152);
    expect(
      minimalTabScrollLeft({ scrollLeft: 0, clientWidth: 400, tabLeft: 350, tabWidth: 100, gutter: 28 }),
    ).toBe(78);
  });

  test("left-aligns a tab wider than the visible strip", () => {
    expect(
      minimalTabScrollLeft({ scrollLeft: 0, clientWidth: 200, tabLeft: 300, tabWidth: 220, gutter: 28 }),
    ).toBe(272);
  });
});

const isBPathDirty = (path: string) => path === "b.ts";

describe("tab close scopes & cycling", () => {
  const tabs = [
    { path: "a.ts", preview: false },
    { path: "b.ts", preview: false },
    { path: "c.ts", preview: false },
    { path: "d.ts", preview: false },
  ];

  test("computes targets for close scopes", () => {
    expect(tabsToClose(tabs, "self", "b.ts", isBPathDirty)).toEqual(["b.ts"]);
    expect(tabsToClose(tabs, "others", "b.ts", isBPathDirty)).toEqual(["a.ts", "c.ts", "d.ts"]);
    expect(tabsToClose(tabs, "right", "b.ts", isBPathDirty)).toEqual(["c.ts", "d.ts"]);
    expect(tabsToClose(tabs, "saved", "b.ts", isBPathDirty)).toEqual(["a.ts", "c.ts", "d.ts"]);
    expect(tabsToClose(tabs, "all", "b.ts", isBPathDirty)).toEqual(["a.ts", "b.ts", "c.ts", "d.ts"]);
  });

  test("cycles forward and backward with wrap-around", () => {
    expect(adjacentTab(tabs, "d.ts", 1)?.path).toBe("a.ts");
    expect(adjacentTab(tabs, "a.ts", -1)?.path).toBe("d.ts");
    expect(adjacentTab(tabs, "b.ts", 1)?.path).toBe("c.ts");
  });
});
