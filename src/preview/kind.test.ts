import { expect, test } from "bun:test";
import { previewKind } from "./kind";

test("a build that says nothing about previews has none: that is the public build", () => {
  expect(previewKind({ DEV: false })).toBe("none");
  expect(previewKind({ DEV: false, VITE_SPROCKT_PREVIEWS: undefined })).toBe("none");
  expect(previewKind({ DEV: false, VITE_SPROCKT_PREVIEWS: "" })).toBe("none");
});

test("only the exact setting turns mounted previews on in a build", () => {
  expect(previewKind({ DEV: false, VITE_SPROCKT_PREVIEWS: "mounted" })).toBe("mounted");
  expect(previewKind({ DEV: false, VITE_SPROCKT_PREVIEWS: "true" })).toBe("none");
  expect(previewKind({ DEV: false, VITE_SPROCKT_PREVIEWS: "isolated" })).toBe("none");
});

test("the dev server always has mounted previews", () => {
  expect(previewKind({ DEV: true })).toBe("mounted");
});
