import { describe, expect, test } from "bun:test";
import { routePath } from "../app/routes";
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

  test("rejects non-GitHub hosts, incomplete paths, and invalid characters", () => {
    expect(parseGithubInput("")).toBeUndefined();
    expect(parseGithubInput("only-owner")).toBeUndefined();
    expect(parseGithubInput("https://gitlab.com/a/b")).toBeUndefined();
    expect(parseGithubInput("https://github.com/a/b/blob/main/index.ts")).toBeUndefined();
    expect(parseGithubInput("https://github.com/a/b/tree")).toBeUndefined();
    expect(parseGithubInput("bad owner/repo")).toBeUndefined();
  });
});
