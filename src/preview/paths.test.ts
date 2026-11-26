import { expect, test } from "bun:test";
import {
  guestPlace,
  isUnderMount,
  mountedPath,
  mountedRedirect,
  normalizePreviewPath,
  parseMountedUrl,
  serverMount,
  workspaceOfPath,
} from "./paths";

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

const ESCAPES = [
  "/../5174/secret",
  "../../other/5173/",
  "/a/../../../x",
  "/%2e%2e/5174/",
  "/%2E%2E/%2e%2e/x",
  "/..%2f../x",
  "\\..\\..\\x",
  "/.\\../x",
  "//elsewhere.test/x",
  "/\\elsewhere.test/x",
  "/../../../w/abc",
];

test("no typed path leaves the mount of the server it was typed for, once a browser resolves it", () => {
  const mount = serverMount("abc", 5173);
  for (const typed of ESCAPES) {
    const resolved = new URL(mountedPath("abc", 5173, typed), ORIGIN);
    expect(resolved.origin).toBe(ORIGIN);
    expect(resolved.pathname.startsWith(`${mount}/`)).toBe(true);
  }
  // The segments are resolved against the server's own root, as its real address bar would.
  expect(mountedPath("abc", 5173, "/../5174/secret")).toBe(`${mount}/5174/secret`);
  expect(mountedPath("abc", 5173, "/docs/../about?x=1#top")).toBe(`${mount}/about?x=1#top`);
  expect(isUnderMount(`${mount}/../5174/`, "abc", 5173)).toBe(false);
  expect(isUnderMount(`${mount}/docs/`, "abc", 5173)).toBe(true);
});

/** A path on the server that wrote the address, which is on port 3000 in these tests. */
const here = (path: string) => ({ port: 3000, path });

test("an address is resolved on the server that wrote it and cannot climb out of it", () => {
  expect(guestPlace("/login", "/account", 3000)).toEqual(here("/login"));
  expect(guestPlace("next?step=2", "/wizard/first", 3000)).toEqual(here("/wizard/next?step=2"));
  expect(guestPlace("../../../../w/abc", "/a/b", 3000)).toEqual(here("/w/abc"));
  expect(guestPlace("/../../__preview/other/3000/", "/", 3000)).toEqual(here("/__preview/other/3000/"));
  expect(guestPlace("/%2e%2e/x", "/", 3000)).toEqual(here("/x"));
  // Another site is not this server's path: it is left as the server wrote it.
  expect(guestPlace("https://example.test/login", "/", 3000)).toBe("elsewhere");
  expect(guestPlace("//example.test/login", "/", 3000)).toBe("elsewhere");
  expect(guestPlace("mailto:someone@example.test", "/", 3000)).toBe("elsewhere");
  expect(guestPlace("http://[bad", "/", 3000)).toBeUndefined();
});

test("a loopback address is a server in the workspace, never the person's own machine", () => {
  // The server's own name for itself, as it builds it from the request it was sent.
  expect(guestPlace("http://localhost:3000/about?x=1#top", "/", 3000)).toEqual({
    port: 3000,
    path: "/about?x=1#top",
  });
  expect(guestPlace("http://127.0.0.1:3000/about", "/", 3000)).toEqual({ port: 3000, path: "/about" });
  expect(guestPlace("http://[::1]:3000/about", "/", 3000)).toEqual({ port: 3000, path: "/about" });
  expect(guestPlace("http://0.0.0.0:3000/", "/", 3000)).toEqual({ port: 3000, path: "/" });
  expect(guestPlace("//localhost:3000/about", "/", 3000)).toEqual({ port: 3000, path: "/about" });
  expect(guestPlace("http://LOCALHOST.:3000/a", "/", 3000)).toEqual({ port: 3000, path: "/a" });
  expect(guestPlace("http://api.localhost:3000/a", "/", 3000)).toEqual({ port: 3000, path: "/a" });
  expect(guestPlace("http://127.8.9.1:3000/a", "/", 3000)).toEqual({ port: 3000, path: "/a" });
  // Another port is the server beside it; no port is the scheme's own.
  expect(guestPlace("http://localhost:8787/api", "/", 3000)).toEqual({ port: 8787, path: "/api" });
  expect(guestPlace("https://localhost/secure", "/", 3000)).toEqual({ port: 443, path: "/secure" });
  expect(guestPlace("ws://localhost:3000/socket", "/", 3000)).toEqual({ port: 3000, path: "/socket" });
  // A name that only looks like one is another site.
  expect(guestPlace("http://localhost.example.test/", "/", 3000)).toBe("elsewhere");
  expect(guestPlace("http://128.0.0.1/", "/", 3000)).toBe("elsewhere");
});

test("a redirect is rewritten to the same place under the mount, wherever it tried to go", () => {
  const mount = serverMount("abc", 3000);
  expect(mountedRedirect("abc", 3000, "/login", "/account")).toBe(`${mount}/login`);
  expect(mountedRedirect("abc", 3000, "step-2", "/wizard/step-1")).toBe(`${mount}/wizard/step-2`);
  // Climbing out with a relative or an absolute path ends at the server's root, inside its mount.
  expect(mountedRedirect("abc", 3000, "../../../../w/abc", "/a")).toBe(`${mount}/w/abc`);
  expect(mountedRedirect("abc", 3000, "/../5174/admin", "/")).toBe(`${mount}/5174/admin`);
  expect(mountedRedirect("abc", 3000, `${mount}/../5174/admin`, "/")).toBe(
    `${mount}/__preview/abc/5174/admin`,
  );
  // Already in the mount, or another site: left as the server wrote it.
  expect(mountedRedirect("abc", 3000, `${mount}/login`, "/")).toBeUndefined();
  expect(mountedRedirect("abc", 3000, "https://example.test/login", "/")).toBeUndefined();
  // The server's absolute address for itself, and for the server beside it: their mounts.
  expect(mountedRedirect("abc", 3000, "http://localhost:3000/about?next=1", "/")).toBe(
    `${mount}/about?next=1`,
  );
  expect(mountedRedirect("abc", 3000, "http://127.0.0.1:3000/", "/deep/page")).toBe(`${mount}/`);
  expect(mountedRedirect("abc", 3000, "http://localhost:8787/api", "/")).toBe(
    `${serverMount("abc", 8787)}/api`,
  );
  expect(mountedRedirect("abc", 3000, "//localhost:3000/about", "/")).toBe(`${mount}/about`);
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
