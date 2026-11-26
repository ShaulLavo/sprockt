import { expect, test } from "bun:test";
import { buildFor, deployFor, fileFor, isIdeHost, isPage, previewHostsEnv } from "./serve-builds";

test("a request sees the deploy with previews unless its cookie says otherwise", () => {
  expect(deployFor(null)).toBe("on");
  expect(deployFor("")).toBe("on");
  expect(deployFor("theme=dark")).toBe("on");
  expect(deployFor("sprockt-build=off")).toBe("off");
  expect(deployFor("theme=dark; sprockt-build=off; x=1")).toBe("off");
  expect(deployFor("sprockt-build=off-old-worker")).toBe("off-old-worker");
  expect(deployFor("sprockt-build=on")).toBe("on");
  expect(deployFor("not-sprockt-build=off")).toBe("on");
  expect(deployFor("sprockt-build=isolated")).toBe("isolated");
});

test("a deploy with isolated previews serves that build, its inert worker file included", () => {
  expect(buildFor("isolated", "/")).toBe("isolated");
  expect(buildFor("isolated", "/preview-sw.js")).toBe("isolated");
  expect(buildFor("isolated", "/preview-frame")).toBe("isolated");
});

test("only the IDE's own name gets the app; every name under it is a preview host", () => {
  expect(isIdeHost("localhost")).toBe(true);
  expect(isIdeHost("127.0.0.1")).toBe(true);
  expect(isIdeHost("abc-3000-pv.localhost")).toBe(false);
  expect(isIdeHost("evil.localhost")).toBe(false);
});

test("the preview hosts get the Worker's bindings for this server's own port", async () => {
  const env = previewHostsEnv(process.cwd(), 4174);
  expect(env.PREVIEW_DOMAIN).toBe("localhost:4174");
  expect(env.IDE_ORIGINS).toBe("http://localhost:4174");
  // The files come from the pinned package, and only from its folder.
  const worker = await env.ASSETS.fetch(new Request("http://x.localhost:4174/sw.js"));
  expect(worker.status).toBe(200);
  expect((await worker.text()).length).toBeGreaterThan(1000);
  const outside = await env.ASSETS.fetch(new Request("http://x.localhost:4174/..%2f..%2fpackage.json"));
  expect(outside.status).toBe(404);
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
