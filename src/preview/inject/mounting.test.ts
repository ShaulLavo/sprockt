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

test("the server's loopback name for itself becomes its mount; the server beside it gets none", () => {
  expect(remounted("http://localhost:5173/login?next=1", PAGE, SERVER)).toBe(`${MOUNT}/login?next=1`);
  expect(remounted("http://127.0.0.1:5173/", PAGE, SERVER)).toBe(`${MOUNT}/`);
  // Another port is another server: it is not given a mount, and the browser is not let go there.
  expect(remounted("http://localhost:8787/api", PAGE, SERVER)).toBeUndefined();
  expect(staysInPreview("http://localhost:8787/api", PAGE, SERVER)).toBe(false);
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

test("the browser may go to another site or stay in its own server's mount, and nowhere else", () => {
  expect(staysInPreview(`${MOUNT}/notes`, PAGE, SERVER)).toBe(true);
  expect(staysInPreview("https://example.test/pay", PAGE, SERVER)).toBe(true);
  expect(staysInPreview("mailto:someone@example.test", PAGE, SERVER)).toBe(true);
  // Another server of the same workspace is not this page's to go to: the workspace alone is
  // not the boundary, the pair of workspace and port is.
  expect(staysInPreview("/__preview/abc/8787/api", PAGE, SERVER)).toBe(false);
  expect(staysInPreview("https://ide.test/__preview/abc/8787/api", PAGE, SERVER)).toBe(false);
  // A loopback address is the person's own machine, whatever the port.
  expect(staysInPreview("http://localhost:5173/", PAGE, SERVER)).toBe(false);
  expect(staysInPreview("http://127.0.0.1:9000/admin", PAGE, SERVER)).toBe(false);
  expect(staysInPreview("https://app.localhost/", PAGE, SERVER)).toBe(false);
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
