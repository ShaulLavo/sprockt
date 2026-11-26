import { expect, test } from "bun:test";
import { buildFor, deployFor, fileFor, isPage } from "./serve-builds";

test("a request sees the deploy with previews unless its cookie says otherwise", () => {
  expect(deployFor(null)).toBe("on");
  expect(deployFor("")).toBe("on");
  expect(deployFor("theme=dark")).toBe("on");
  expect(deployFor("sprockt-build=off")).toBe("off");
  expect(deployFor("theme=dark; sprockt-build=off; x=1")).toBe("off");
  expect(deployFor("sprockt-build=off-old-worker")).toBe("off-old-worker");
  expect(deployFor("sprockt-build=on")).toBe("on");
  expect(deployFor("not-sprockt-build=off")).toBe("on");
});

test("a deploy without previews serves that build, except a worker file that has not caught up", () => {
  expect(buildFor("on", "/preview-sw.js")).toBe("on");
  expect(buildFor("off", "/preview-sw.js")).toBe("off");
  expect(buildFor("off", "/")).toBe("off");
  expect(buildFor("off-old-worker", "/preview-sw.js")).toBe("on");
  expect(buildFor("off-old-worker", "/")).toBe("off");
  expect(buildFor("off-old-worker", "/assets/index.js")).toBe("off");
});

test("a path names a file under the build, and never one outside it", () => {
  expect(fileFor("/app/dist", "/assets/a.js")).toBe("/app/dist/assets/a.js");
  expect(fileFor("/app/dist", "/")).toBe("/app/dist/");
  expect(fileFor("/app/dist", "/..%2f..%2fetc/passwd")).toBeUndefined();
  expect(fileFor("/app/dist", "/../dist-previews-off/index.html")).toBeUndefined();
  expect(fileFor("/app/dist", "/%E0%A4%A")).toBeUndefined();
});

test("a path without an extension is a page of the app", () => {
  expect(isPage("/")).toBe(true);
  expect(isPage("/w/abc")).toBe(true);
  expect(isPage("/__preview/abc/3000/")).toBe(true);
  expect(isPage("/preview-sw.js")).toBe(false);
  expect(isPage("/assets/index-abc.css")).toBe(false);
});
