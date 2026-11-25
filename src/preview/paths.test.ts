import { expect, test } from "bun:test";
import { mountedPath, normalizePreviewPath, parseMountedUrl, serverMount, workspaceOfPath } from "./paths";

const ORIGIN = "https://ide.test";

test("what is typed in the URL bar becomes a path the server understands", () => {
  expect(normalizePreviewPath("")).toBe("/");
  expect(normalizePreviewPath("  ")).toBe("/");
  expect(normalizePreviewPath("about")).toBe("/about");
  expect(normalizePreviewPath("/about?x=1#top")).toBe("/about?x=1#top");
  expect(normalizePreviewPath(" /spaced ")).toBe("/spaced");
});

test("a mounted path names the workspace, then the port, then the server's path", () => {
  expect(serverMount("abc", 5173)).toBe("/__preview/abc/5173");
  expect(mountedPath("abc", 5173, "/")).toBe("/__preview/abc/5173/");
  expect(mountedPath("abc", 3000, "docs/intro?x=1")).toBe("/__preview/abc/3000/docs/intro?x=1");
});

test("a mounted URL is read back into workspace, port and path", () => {
  expect(parseMountedUrl(`${ORIGIN}/__preview/abc/5173/docs/intro?x=1#top`, ORIGIN)).toEqual({
    workspace: "abc",
    port: 5173,
    path: "/docs/intro?x=1#top",
  });
  expect(parseMountedUrl(`${ORIGIN}/__preview/abc/5173`, ORIGIN)).toEqual({
    workspace: "abc",
    port: 5173,
    path: "/",
  });
});

test("URLs that are not a mounted preview of this origin are not read as one", () => {
  expect(parseMountedUrl("https://elsewhere.test/__preview/abc/5173/", ORIGIN)).toBeUndefined();
  expect(parseMountedUrl(`${ORIGIN}/w/abc`, ORIGIN)).toBeUndefined();
  expect(parseMountedUrl(`${ORIGIN}/__preview/5173/`, ORIGIN)).toBeUndefined();
  expect(parseMountedUrl(`${ORIGIN}/__preview/Not_A_Workspace/5173/`, ORIGIN)).toBeUndefined();
  expect(parseMountedUrl(`${ORIGIN}/__preview/abc/notaport/`, ORIGIN)).toBeUndefined();
  expect(parseMountedUrl("not a url", ORIGIN)).toBeUndefined();
});

test("the workspace of a path under /__preview/ is found, and of no other path", () => {
  expect(workspaceOfPath("/__preview/abc/5173/src/main.tsx")).toBe("abc");
  expect(workspaceOfPath("/__preview/abc")).toBe("abc");
  expect(workspaceOfPath("/__preview/")).toBeUndefined();
  expect(workspaceOfPath("/__preview/Bad_Id/5173/")).toBeUndefined();
  expect(workspaceOfPath("/src/main.tsx")).toBeUndefined();
});
