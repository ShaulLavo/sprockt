import { expect, test } from "bun:test";
import { DOMAIN_ATTRIBUTE, framePageHtml } from "./frame-page-html";
import { publishedEntries } from "./vite-plugin";

test("the page loads its one script and tells it the build's preview domain", () => {
  const html = framePageHtml("sprockt.dev");
  expect(html).toStartWith("<!doctype html>");
  expect(html).toContain(`<script src="/preview-frame.js" ${DOMAIN_ATTRIBUTE}="sprockt.dev"></script>`);
  // Nothing of the app: no module script, no stylesheet or chunk to fetch.
  expect(html).not.toContain('type="module"');
  expect(html).not.toContain("/assets/");
  expect(html.match(/<script/g)).toHaveLength(1);
});

test("the domain cannot break out of its attribute", () => {
  const html = framePageHtml('x" onload="alert(1)"><script>');
  expect(html.match(/<script/g)).toHaveLength(1);
  expect(html).toContain("&quot;");
});

test("only a build with isolated previews publishes the page's script", () => {
  expect(Object.keys(publishedEntries("isolated"))).toEqual(["/preview-sw.js", "/preview-frame.js"]);
  expect(Object.keys(publishedEntries("none"))).toEqual(["/preview-sw.js"]);
  expect(Object.keys(publishedEntries("mounted"))).toEqual(["/preview-sw.js", "/preview-client.js"]);
});

test("a build without mounted previews puts the inert worker where the routing one was", () => {
  expect(publishedEntries("isolated")["/preview-sw.js"]).toBe("src/preview/sw-off.ts");
  expect(publishedEntries("none")["/preview-sw.js"]).toBe("src/preview/sw-off.ts");
  expect(publishedEntries("mounted")["/preview-sw.js"]).toBe("src/preview/sw.ts");
});
