import { expect, test } from "bun:test";
import { framedTarget, remounted, staysInPreview } from "./mounting";

const MOUNT = "/__preview/abc/5173";
const SERVER = { port: 5173, mount: MOUNT };
const PAGE = new URL(`https://ide.test${MOUNT}/notes/list?page=2`);

test("a root-absolute address means the server's root, so it goes under the mount", () => {
  expect(remounted("/notes", PAGE, SERVER)).toBe(`${MOUNT}/notes`);
  expect(remounted("/search?q=a#top", PAGE, SERVER)).toBe(`${MOUNT}/search?q=a#top`);
  expect(remounted("https://ide.test/", PAGE, SERVER)).toBe(`${MOUNT}/`);
  // Another server's mount is not this page's to reach.
  expect(remounted("/__preview/abc/3000/admin", PAGE, SERVER)).toBe(`${MOUNT}/__preview/abc/3000/admin`);
});

test("a relative address is resolved on the server, from where the page is on it", () => {
  // The page is the server's /notes/list.
  expect(remounted("../../../../w/abc", PAGE, SERVER)).toBe(`${MOUNT}/w/abc`);
  expect(remounted("../..", PAGE, SERVER)).toBe(`${MOUNT}/`);
  expect(remounted("../../x", new URL(`https://ide.test${MOUNT}/a/b`), SERVER)).toBe(`${MOUNT}/x`);
});

test("the server's loopback name for itself, or for the server beside it, becomes a mount", () => {
  expect(remounted("http://localhost:5173/login?next=1", PAGE, SERVER)).toBe(`${MOUNT}/login?next=1`);
  expect(remounted("http://127.0.0.1:5173/", PAGE, SERVER)).toBe(`${MOUNT}/`);
  expect(remounted("http://localhost:8787/api", PAGE, SERVER)).toBe("/__preview/abc/8787/api");
});

test("an address that is already in the mount, or on another site, is left alone", () => {
  expect(remounted("edit", PAGE, SERVER)).toBeUndefined();
  expect(remounted("", PAGE, SERVER)).toBeUndefined();
  expect(remounted("?page=3", PAGE, SERVER)).toBeUndefined();
  expect(remounted(`${MOUNT}/notes`, PAGE, SERVER)).toBeUndefined();
  expect(remounted(`https://ide.test${MOUNT}/notes`, PAGE, SERVER)).toBeUndefined();
  expect(remounted("https://example.test/notes", PAGE, SERVER)).toBeUndefined();
  expect(remounted("mailto:someone@example.test", PAGE, SERVER)).toBeUndefined();
  expect(remounted("http://[bad", PAGE, SERVER)).toBeUndefined();
});

test("the browser may go to another site or stay in the workspace's previews, never to the IDE", () => {
  expect(staysInPreview(`${MOUNT}/notes`, PAGE, SERVER)).toBe(true);
  expect(staysInPreview("/__preview/abc/8787/api", PAGE, SERVER)).toBe(true);
  expect(staysInPreview("https://example.test/pay", PAGE, SERVER)).toBe(true);
  expect(staysInPreview("/notes", PAGE, SERVER)).toBe(false);
  expect(staysInPreview("/w/abc", PAGE, SERVER)).toBe(false);
  expect(staysInPreview("/__preview/other/5173/", PAGE, SERVER)).toBe(false);
  expect(staysInPreview("/__preview/abc", PAGE, SERVER)).toBe(false);
  expect(staysInPreview("http://[bad", PAGE, SERVER)).toBe(false);
});

test("a link or form aimed at the frames around the preview stays in the preview's frame", () => {
  expect(framedTarget("_top", true)).toBe("_self");
  expect(framedTarget(" _PARENT ", true)).toBe("_self");
  expect(framedTarget("_blank", true)).toBe("_blank");
  expect(framedTarget("results", true)).toBe("results");
  expect(framedTarget(null, true)).toBeNull();
  // In its own tab there is no IDE around it.
  expect(framedTarget("_top", false)).toBe("_top");
});
