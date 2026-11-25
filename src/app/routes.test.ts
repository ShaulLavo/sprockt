import { describe, expect, test } from "bun:test";
import { parseRoute, routePath, type Route } from "./routes";

describe("parseRoute", () => {
  test("the root is the landing page", () => {
    expect(parseRoute("/")).toEqual({ kind: "landing" });
  });

  test("a workspace path carries its id", () => {
    expect(parseRoute("/w/abc123")).toEqual({ kind: "workspace", id: "abc123" });
    expect(parseRoute("/w/abc123/")).toEqual({ kind: "workspace", id: "abc123" });
  });

  test("a workspace path with a bad id or extra segments is not found", () => {
    expect(parseRoute("/w/")).toEqual({ kind: "not-found" });
    expect(parseRoute("/w/Has_Upper")).toEqual({ kind: "not-found" });
    expect(parseRoute("/w/abc/extra")).toEqual({ kind: "not-found" });
  });

  test("a GitHub repository path, with and without a branch and a subdirectory", () => {
    expect(parseRoute("/github/oven-sh/bun")).toEqual({ kind: "github", owner: "oven-sh", repo: "bun" });
    expect(parseRoute("/github/a/b/tree/main")).toEqual({
      kind: "github",
      owner: "a",
      repo: "b",
      branch: "main",
    });
    expect(parseRoute("/github/a/b/tree/main/examples/vite")).toEqual({
      kind: "github",
      owner: "a",
      repo: "b",
      branch: "main",
      subdir: "examples/vite",
    });
  });

  test("an incomplete or malformed GitHub path is not found", () => {
    expect(parseRoute("/github/owner")).toEqual({ kind: "not-found" });
    expect(parseRoute("/github/a/b/blob/main")).toEqual({ kind: "not-found" });
    expect(parseRoute("/github/a/b/tree")).toEqual({ kind: "not-found" });
    expect(parseRoute("/github/a%20b/c")).toEqual({ kind: "not-found" });
  });

  test("anything else is not found", () => {
    expect(parseRoute("/settings")).toEqual({ kind: "not-found" });
  });
});

describe("routePath", () => {
  const routes: Route[] = [
    { kind: "landing" },
    { kind: "workspace", id: "abc123" },
    { kind: "github", owner: "a", repo: "b" },
    { kind: "github", owner: "a", repo: "b", branch: "feature/x" },
    { kind: "github", owner: "a", repo: "b", branch: "main", subdir: "examples/vite" },
  ];

  test.each(routes)("round-trips %j through parseRoute", (route) => {
    expect(parseRoute(routePath(route))).toEqual(route);
  });
});
