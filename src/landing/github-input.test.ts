import { describe, expect, test } from "bun:test";
import { parseRoute, routePath } from "../routing/routes";
import { parseGithubInput } from "./github-input";

describe("parseGithubInput", () => {
  test("accepts owner/repo shorthand", () => {
    const route = parseGithubInput("ShaulLavo/bash-web");
    expect(route).toEqual({ kind: "github", owner: "ShaulLavo", repo: "bash-web" });
    expect(route && routePath(route)).toBe("/github/ShaulLavo/bash-web");
  });

  test("accepts full GitHub URLs with or without scheme, www, trailing slash, or .git", () => {
    expect(parseGithubInput("https://github.com/oven-sh/bun")).toEqual({
      kind: "github",
      owner: "oven-sh",
      repo: "bun",
    });
    expect(parseGithubInput("http://www.github.com/oven-sh/bun.git/")).toEqual({
      kind: "github",
      owner: "oven-sh",
      repo: "bun",
    });
    expect(parseGithubInput("github.com/honojs/hono?tab=readme-ov-file")).toEqual({
      kind: "github",
      owner: "honojs",
      repo: "hono",
    });
  });

  test("accepts branch and subdirectory tree URLs", () => {
    const route = parseGithubInput("https://github.com/oven-sh/bun/tree/main/examples/vite");
    expect(route).toEqual({
      kind: "github",
      owner: "oven-sh",
      repo: "bun",
      branch: "main",
      subdir: "examples/vite",
    });
    expect(route && routePath(route)).toBe("/github/oven-sh/bun/tree/main/examples/vite");
  });

  test("decodes percent-encoded branches and subdirectories once without double-encoding", () => {
    const unicodeSubdir = parseGithubInput("https://github.com/owner/repo/tree/main/docs/Caf%C3%A9");
    expect(unicodeSubdir).toEqual({
      kind: "github",
      owner: "owner",
      repo: "repo",
      branch: "main",
      subdir: "docs/Café",
    });
    expect(unicodeSubdir && routePath(unicodeSubdir)).toBe("/github/owner/repo/tree/main/docs/Caf%C3%A9");
    expect(unicodeSubdir && parseRoute(routePath(unicodeSubdir))).toEqual(unicodeSubdir);

    const slashBranch = parseGithubInput("https://github.com/owner/repo/tree/feature%2Fx/packages/my%20app");
    expect(slashBranch).toEqual({
      kind: "github",
      owner: "owner",
      repo: "repo",
      branch: "feature/x",
      subdir: "packages/my app",
    });
    expect(slashBranch && routePath(slashBranch)).toBe(
      "/github/owner/repo/tree/feature%2Fx/packages/my%20app",
    );
  });

  test("rejects non-GitHub hosts, incomplete paths, malformed escapes, dot segments, and invalid characters", () => {
    expect(parseGithubInput("")).toBeUndefined();
    expect(parseGithubInput("only-owner")).toBeUndefined();
    expect(parseGithubInput("https://gitlab.com/a/b")).toBeUndefined();
    expect(parseGithubInput("https://github.com/a/b/blob/main/index.ts")).toBeUndefined();
    expect(parseGithubInput("https://github.com/a/b/tree")).toBeUndefined();
    expect(parseGithubInput("bad owner/repo")).toBeUndefined();
    expect(parseGithubInput("https://github.com/a/b/tree/main/%ZZ")).toBeUndefined();
    expect(parseGithubInput("owner/repo/tree/main/%ZZ")).toBeUndefined();
    expect(parseGithubInput("./owner/repo")).toBeUndefined();
    expect(parseGithubInput("../owner/repo")).toBeUndefined();
    expect(parseGithubInput("owner/..")).toBeUndefined();
    expect(parseGithubInput("owner/repo/tree/main/../etc")).toBeUndefined();
    expect(parseGithubInput("https://github.com/owner/repo/tree/main/%2e%2e/etc")).toBeUndefined();
  });
});
