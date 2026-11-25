import { describe, expect, test } from "bun:test";
import { isRefComponent, isRefName } from "./names.ts";
import {
  chooseSplit,
  githubImportPath,
  parseGitHubSource,
  refCandidates,
  type GitHubSource,
} from "./source.ts";

function parse(input: string): GitHubSource {
  const result = parseGitHubSource(input);
  if (!result.ok) throw new Error(result.error);
  return result.source;
}

describe("parseGitHubSource", () => {
  const plain: GitHubSource = { owner: "oven-sh", repo: "bun", refAndPath: [], target: "tree" };

  test.each([
    "/github/oven-sh/bun",
    "/github/oven-sh/bun/",
    "https://github.com/oven-sh/bun",
    "https://github.com/oven-sh/bun/",
    "https://github.com/oven-sh/bun.git",
    "http://www.github.com/oven-sh/bun",
    "github.com/oven-sh/bun",
    "  https://github.com/oven-sh/bun?tab=readme#install  ",
    "git@github.com:oven-sh/bun.git",
    "oven-sh/bun",
    "https://github.com/oven-sh/bun/issues/123",
    "https://GitHub.com/oven-sh/bun",
  ])("whole repository: %s", (input) => {
    expect(parse(input)).toEqual(plain);
  });

  test("tree URLs keep the ref and path segments", () => {
    expect(parse("https://github.com/vitejs/vite/tree/main/packages/create-vite")).toEqual({
      owner: "vitejs",
      repo: "vite",
      refAndPath: ["main", "packages", "create-vite"],
      target: "tree",
    });
    expect(parse("/github/vitejs/vite/tree/v5.0.0").refAndPath).toEqual(["v5.0.0"]);
  });

  test("blob URLs import the repository at that ref", () => {
    const source = parse("https://github.com/honojs/hono/blob/main/src/index.ts");
    expect(source.target).toBe("blob");
    expect(refCandidates(source)[0]).toEqual({ ref: "main", subdir: "" });
  });

  test("commit URLs use the commit as the ref", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(parse(`https://github.com/a/b/commit/${sha}`).refAndPath).toEqual([sha]);
  });

  test("decodes percent-encoded segments", () => {
    expect(parse("/github/a/b/tree/feat%2Bx/my%20dir").refAndPath).toEqual(["feat+x", "my dir"]);
  });

  test.each([
    ["", "not a GitHub repository URL"],
    ["https://gitlab.com/a/b", "not a GitHub repository URL"],
    ["https://github.com/onlyowner", "not a valid GitHub repository name"],
    ["https://github.com/-bad/repo", "not a valid GitHub owner name"],
    ["/github/a/..", "not a valid GitHub repository name"],
    ["/github/a/b/tree/..", "not a valid branch"],
    ["/github/a/b/tree/%E0%A4%A", "not a GitHub repository URL"],
  ])("rejects %p", (input, message) => {
    const result = parseGitHubSource(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(message);
  });
});

describe("refCandidates", () => {
  test("default branch when no ref is given", () => {
    expect(refCandidates(parse("a/b"))).toEqual([{ ref: "", subdir: "" }]);
  });

  test("lists every split for refs that may contain slashes", () => {
    expect(refCandidates(parse("/github/a/b/tree/feature/x/src/app"))).toEqual([
      { ref: "feature", subdir: "x/src/app" },
      { ref: "feature/x", subdir: "src/app" },
      { ref: "feature/x/src", subdir: "app" },
      { ref: "feature/x/src/app", subdir: "" },
    ]);
  });

  test("lists every split, however deep, and allows non-ASCII branch names", () => {
    expect(refCandidates(parse("/github/a/b/tree/1/2/3/4/5/6"))).toHaveLength(6);
    const accented = refCandidates(parse("https://github.com/a/b/tree/caf%C3%A9/menu"));
    expect(accented.map((split) => split.ref)).toEqual(["café", "café/menu"]);
  });
});

describe("ref components", () => {
  test("tree links whose first component is only valid inside a longer ref parse", () => {
    expect(refCandidates(parse("https://github.com/a/b/tree/release./stable/src"))).toEqual([
      { ref: "release./stable", subdir: "src" },
      { ref: "release./stable/src", subdir: "" },
    ]);
    expect(refCandidates(parse("https://github.com/a/b/tree/@/stable")).map((split) => split.ref)).toEqual([
      "@/stable",
    ]);
  });

  test.each(["release.", "@", "main", "café"])("isRefComponent accepts %p", (segment) => {
    expect(isRefComponent(segment)).toBe(true);
  });

  test.each(["", ".x", "a.lock", "a..b", "a@{b", "a/b", "sp ace", "q?"])(
    "isRefComponent rejects %p",
    (segment) => {
      expect(isRefComponent(segment)).toBe(false);
    },
  );
});

describe("chooseSplit", () => {
  const splits = refCandidates(parse("/github/a/b/tree/feature/x/src/app"));

  test("picks the longest existing ref", () => {
    expect(chooseSplit(splits, { branches: ["feature/x", "feature-y"], tags: [] })).toEqual({
      ref: "feature/x",
      subdir: "src/app",
      fetchRef: "refs/heads/feature/x",
    });
  });

  test("a shorter tag does not mask a longer branch, and a branch beats a same-named tag", () => {
    expect(chooseSplit(splits, { branches: ["feature/x"], tags: ["feature"] })?.fetchRef).toBe(
      "refs/heads/feature/x",
    );
    expect(chooseSplit(splits, { branches: ["feature/x"], tags: ["feature/x"] })?.fetchRef).toBe(
      "refs/heads/feature/x",
    );
    expect(chooseSplit(splits, { branches: [], tags: ["feature"] })).toEqual({
      ref: "feature",
      subdir: "x/src/app",
      fetchRef: "refs/tags/feature",
    });
  });

  test("nothing matches", () => {
    expect(chooseSplit(splits, { branches: ["feat"], tags: ["feature/xy"] })).toBeUndefined();
  });
});

describe("isRefName", () => {
  test.each([
    "main",
    "teams/frontend/release/stable/v1",
    "café",
    "feat+x",
    "v1.2.0",
    "a./b",
    "a@b",
    "#hash",
    "x{y}",
  ])("accepts %p", (ref) => {
    expect(isRefName(ref)).toBe(true);
  });

  test.each([
    "",
    "@",
    "a..b",
    "a@{1}",
    ".hidden",
    "a/.b",
    "x.lock",
    "a/b.lock/c",
    "end.",
    "a//b",
    "a/",
    "/a",
    "sp ace",
    "t~1",
    "c^2",
    "a:b",
    "q?",
    "s*",
    "b[1",
    "back\\slash",
    "ctl\u0001",
  ])("rejects %p", (ref) => {
    expect(isRefName(ref)).toBe(false);
  });
});

describe("githubImportPath", () => {
  test("round-trips through the parser", () => {
    const path = githubImportPath("vitejs", "vite", "main", "packages/create vite");
    expect(path).toBe("/github/vitejs/vite/tree/main/packages/create%20vite");
    expect(refCandidates(parse(path))[0]).toEqual({ ref: "main", subdir: "packages/create vite" });
    expect(githubImportPath("a", "b")).toBe("/github/a/b");
  });
});
