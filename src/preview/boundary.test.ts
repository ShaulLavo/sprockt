import { expect, test } from "bun:test";
import { routeRequest, socketAllowed, type Route } from "./boundary";
import type { MountedLocation } from "./paths";

const ORIGIN = "https://sprockt.test";
/** A previewed page of workspace `abc`, served by its server on port 3000. */
const PAGE: MountedLocation = { workspace: "abc", port: 3000, path: "/notes" };
const route = (path: string, source: MountedLocation | undefined = PAGE) =>
  routeRequest(`${ORIGIN}${path}`, ORIGIN, source);
const refuse: Route = { to: "refuse" };

test("a previewed page is served from its own server's mount", () => {
  expect(route("/__preview/abc/3000/app.js")).toEqual({
    to: "mount",
    place: { workspace: "abc", port: 3000, path: "/app.js" },
  });
  expect(route("/__preview/abc/3000/")).toMatchObject({ to: "mount" });
});

test("a previewed page asking for another workspace's mount is refused, whatever the port", () => {
  // The address names the other workspace, and the worker used to go by the address.
  expect(route("/__preview/other/3000/secret")).toEqual(refuse);
  expect(route("/__preview/other/8080/")).toEqual(refuse);
  // Spelled so that it only looks like its own mount.
  expect(route("/__preview/abc/3000/../../other/3000/secret")).toEqual(refuse);
  expect(route("/__preview/abc/3000/%2e%2e/%2e%2e/other/3000/secret")).toEqual(refuse);
});

test("a previewed page asking for another server of its own workspace is refused too", () => {
  expect(route("/__preview/abc/8787/api")).toEqual(refuse);
  expect(route("/__preview/abc/3000/../8787/api")).toEqual(refuse);
});

test("under the previews' prefix but in no server's mount, there is nothing of the page's", () => {
  expect(route("/__preview")).toEqual(refuse);
  expect(route("/__preview/")).toEqual(refuse);
  expect(route("/__preview/abc")).toEqual(refuse);
  expect(route("/__preview/abc/not-a-port/x")).toEqual(refuse);
  expect(route("/__preview/Not%20A%20Workspace/3000/")).toEqual(refuse);
});

test("a path outside every mount, asked for by a previewed page, is its own server's path", () => {
  expect(route("/src/main.tsx")).toEqual({ to: "own", home: PAGE });
  expect(route("/@vite/client")).toEqual({ to: "own", home: PAGE });
  expect(route("/__previewish/x")).toEqual({ to: "own", home: PAGE });
  // Also the IDE's own pages and files, seen from a preview: they are the server's paths there.
  expect(route("/w/abc")).toEqual({ to: "own", home: PAGE });
});

test("with no previewed page behind it, a request goes where its address says", () => {
  // The pane pointing its frame at a server, or a tab a person opened.
  expect(routeRequest(`${ORIGIN}/__preview/other/8080/x?y=1`, ORIGIN, undefined)).toEqual({
    to: "mount",
    place: { workspace: "other", port: 8080, path: "/x?y=1" },
  });
  expect(routeRequest(`${ORIGIN}/__preview/abc`, ORIGIN, undefined)).toEqual({ to: "network" });
  expect(routeRequest(`${ORIGIN}/assets/app.js`, ORIGIN, undefined)).toEqual({ to: "network" });
});

test("a page's WebSocket reaches the server it was loaded from, and no other port", () => {
  const page = `${ORIGIN}/__preview/abc/3000/notes`;
  expect(socketAllowed(page, ORIGIN, 3000)).toEqual({ workspace: "abc", port: 3000, path: "/notes" });
  // The page names the port itself, so a page of one server could name another's.
  expect(socketAllowed(page, ORIGIN, 8787)).toBeUndefined();
  // Not a previewed page at all.
  expect(socketAllowed(`${ORIGIN}/w/abc`, ORIGIN, 3000)).toBeUndefined();
  expect(socketAllowed("https://example.test/__preview/abc/3000/", ORIGIN, 3000)).toBeUndefined();
});
