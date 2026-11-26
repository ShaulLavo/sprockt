import { expect, test } from "bun:test";
import { previewDomain, previewKind } from "./kind";

test("a build that says nothing about previews has none", () => {
  expect(previewKind({ DEV: false })).toBe("none");
  expect(previewKind({ DEV: false, VITE_SPROCKT_PREVIEWS: undefined })).toBe("none");
  expect(previewKind({ DEV: false, VITE_SPROCKT_PREVIEWS: "" })).toBe("none");
  expect(previewKind({ DEV: false, VITE_SPROCKT_PREVIEW_DOMAIN: "" })).toBe("none");
  expect(previewKind({ DEV: false, VITE_SPROCKT_PREVIEW_DOMAIN: "  " })).toBe("none");
});

test("only the exact setting turns mounted previews on in a build", () => {
  expect(previewKind({ DEV: false, VITE_SPROCKT_PREVIEWS: "mounted" })).toBe("mounted");
  expect(previewKind({ DEV: false, VITE_SPROCKT_PREVIEWS: "true" })).toBe("none");
  expect(previewKind({ DEV: false, VITE_SPROCKT_PREVIEWS: "isolated" })).toBe("none");
});

test("the dev server always has mounted previews", () => {
  expect(previewKind({ DEV: true })).toBe("mounted");
  expect(previewKind({ DEV: true, VITE_SPROCKT_PREVIEW_DOMAIN: "sprockt.dev" })).toBe("mounted");
});

test("a build that names a preview domain has isolated previews: that is the public build", () => {
  expect(previewKind({ DEV: false, VITE_SPROCKT_PREVIEW_DOMAIN: "sprockt.dev" })).toBe("isolated");
  expect(previewKind({ DEV: false, VITE_SPROCKT_PREVIEW_DOMAIN: "localhost:4174" })).toBe("isolated");
});

test("a build that names a preview domain cannot be mounted: it fails instead of shipping", () => {
  // Naming the domain says the build is for the public. A left-over `mounted` setting must not
  // quietly win, and must not quietly lose either.
  const build = { DEV: false, VITE_SPROCKT_PREVIEWS: "mounted", VITE_SPROCKT_PREVIEW_DOMAIN: "sprockt.dev" };
  expect(() => previewKind(build)).toThrow("cannot go together");
  // Each setting alone is fine.
  expect(previewKind({ DEV: false, VITE_SPROCKT_PREVIEWS: "mounted" })).toBe("mounted");
  expect(
    previewKind({ DEV: false, VITE_SPROCKT_PREVIEWS: "mounted", VITE_SPROCKT_PREVIEW_DOMAIN: " " }),
  ).toBe("mounted");
  expect(previewKind({ DEV: false, VITE_SPROCKT_PREVIEW_DOMAIN: "sprockt.dev" })).toBe("isolated");
});

test("the preview domain is a host name, in one spelling", () => {
  expect(previewDomain({ DEV: false, VITE_SPROCKT_PREVIEW_DOMAIN: " Sprockt.DEV " })).toBe("sprockt.dev");
  expect(previewDomain({ DEV: false })).toBeUndefined();
});

test("a preview domain that is not a host name fails the build instead of shipping", () => {
  for (const domain of [
    "https://sprockt.dev",
    "sprockt.dev/",
    "*.sprockt.dev",
    "sprockt dev",
    ".sprockt.dev",
  ]) {
    expect(() => previewKind({ DEV: false, VITE_SPROCKT_PREVIEW_DOMAIN: domain })).toThrow("not a host name");
  }
});
