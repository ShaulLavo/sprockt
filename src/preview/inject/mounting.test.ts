import { expect, test } from "bun:test";
import { remounted } from "./mounting";

const MOUNT = "/__preview/abc/5173";
const PAGE = new URL(`https://ide.test${MOUNT}/notes/list?page=2`);

test("a root-absolute address means the server's root, so it goes under the mount", () => {
  expect(remounted("/notes", PAGE, MOUNT)).toBe(`${MOUNT}/notes`);
  expect(remounted("/search?q=a#top", PAGE, MOUNT)).toBe(`${MOUNT}/search?q=a#top`);
  expect(remounted("https://ide.test/", PAGE, MOUNT)).toBe(`${MOUNT}/`);
  // Climbing out with dots ends at the origin's root, which is the server's root.
  expect(remounted("../../../../w/abc", PAGE, MOUNT)).toBe(`${MOUNT}/w/abc`);
  // Another server's mount is not this page's to reach.
  expect(remounted("/__preview/abc/3000/admin", PAGE, MOUNT)).toBe(`${MOUNT}/__preview/abc/3000/admin`);
});

test("an address that is already in the mount, or on another site, is left alone", () => {
  expect(remounted("edit", PAGE, MOUNT)).toBeUndefined();
  expect(remounted(`${MOUNT}/notes`, PAGE, MOUNT)).toBeUndefined();
  expect(remounted(MOUNT, PAGE, MOUNT)).toBeUndefined();
  expect(remounted("https://example.test/notes", PAGE, MOUNT)).toBeUndefined();
  expect(remounted("mailto:someone@example.test", PAGE, MOUNT)).toBeUndefined();
  expect(remounted("http://[bad", PAGE, MOUNT)).toBeUndefined();
});
