import { expect, test } from "bun:test";
import { previewOriginId } from "bun-wasm/preview-origins";
import { framePage, placeReport, previewOrigins, RETRY_DELAYS_MS } from "./isolated-origins";

const IDE = "https://sprockt.dev";
const config = { domain: "sprockt.dev" };

const idOf = (identity: string, ideOrigin = IDE) => previewOriginId(ideOrigin, identity);

test("every server of a workspace has a host of its own under the preview domain", async () => {
  const id = await idOf("one");
  const origins = previewOrigins(config, id);
  expect(origins.origin(5173)).toBe(`https://${id}-5173-pv.sprockt.dev`);
  expect(origins.origin(3000)).toBe(`https://${id}-3000-pv.sprockt.dev`);
  expect(id).toMatch(/^[a-z2-7]{52}$/);
  // One label, so the zone's single-level wildcard certificate covers it.
  expect(new URL(origins.origin(5173)).hostname.split(".")).toHaveLength(3);
});

test("the names follow the workspace's identity and the IDE's origin, and nothing else", async () => {
  expect(await idOf("one")).toBe(await idOf("one"));
  // A workspace created again has a new identity, so it does not get its predecessor's origins.
  expect(await idOf("one")).not.toBe(await idOf("two"));
  // The same workspace under another IDE origin (the owner's private preview) is kept apart too.
  expect(await idOf("one", "https://fregat.sprockt.dev")).not.toBe(await idOf("one"));
});

test("a local build names hosts under localhost, over plain http", async () => {
  const id = await idOf("one", "http://localhost:4174");
  const origins = previewOrigins({ domain: "localhost:4174" }, id);
  expect(origins.origin(3000)).toBe(`http://${id}-3000-pv.localhost:4174`);
});

test("a path stays on its server's origin, whatever is typed", async () => {
  const origins = previewOrigins(config, await idOf("one"));
  const origin = origins.origin(5173);
  expect(origins.url(5173, "/")).toBe(`${origin}/`);
  expect(origins.url(5173, "/about?tab=1#top")).toBe(`${origin}/about?tab=1#top`);
  expect(origins.url(5173, "//evil.example/steal")).toBe(`${origin}/evil.example/steal`);
  expect(origins.url(5173, "/\\evil.example")).toBe(`${origin}/evil.example`);
  expect(origins.url(5173, "@evil.example/")).toBe(`${origin}/@evil.example/`);
  expect(origins.url(5173, "/../../x")).toBe(`${origin}/x`);
});

test("an address is located only when it is one of this workspace's own", async () => {
  const id = await idOf("one");
  const origins = previewOrigins(config, id);
  expect(origins.locate(`https://${id}-5173-pv.sprockt.dev/about?tab=1#top`)).toEqual({
    port: 5173,
    path: "/about?tab=1#top",
  });
  expect(origins.locate(`https://${id}-3000-pv.sprockt.dev/`)).toEqual({ port: 3000, path: "/" });
  // Another workspace's host, the IDE, another site, another scheme, and no address at all.
  expect(origins.locate(`https://${await idOf("two")}-5173-pv.sprockt.dev/`)).toBeUndefined();
  expect(origins.locate("https://sprockt.dev/w/abc")).toBeUndefined();
  expect(origins.locate(`https://${id}-5173-pv.example.com/`)).toBeUndefined();
  expect(origins.locate(`http://${id}-5173-pv.sprockt.dev/`)).toBeUndefined();
  expect(origins.locate("about:blank")).toBeUndefined();
  expect(origins.locate("not a url")).toBeUndefined();
});

test("a new tab goes through a page of the IDE's origin that takes the preview in `url`", async () => {
  const preview = `${previewOrigins(config, await idOf("one")).origin(5173)}/about?tab=1#top`;
  const page = new URL(framePage(IDE, preview));
  expect(page.origin).toBe(IDE);
  expect(page.pathname).toBe("/preview-frame");
  expect(page.searchParams.get("url")).toBe(preview);
});

test("a page's report of where it is becomes the pane's location message", () => {
  const href = "https://id-5173-pv.sprockt.dev/about";
  const type = "bunwasm-preview-frame";
  expect(placeReport({ type, event: "commit", href, title: "About" })).toEqual({
    source: "sprockt-preview",
    type: "location",
    href,
    title: "About",
  });
  expect(placeReport({ type, event: "load", href })).toMatchObject({ type: "location", href, title: "" });
  // The service worker answering in the server's place names no place the page is at.
  expect(placeReport({ type, event: "error", href, transient: true })).toBeUndefined();
});

test("a frame whose server is not reachable yet is tried again a few times, then left alone", () => {
  expect(RETRY_DELAYS_MS.length).toBeGreaterThan(0);
  expect(RETRY_DELAYS_MS.length).toBeLessThanOrEqual(5);
});
