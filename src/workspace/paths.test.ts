import { expect, test } from "bun:test";
import {
  isInsideProject,
  isWorkspaceId,
  linkTarget,
  newWorkspaceId,
  projectPath,
  ProjectPathError,
  projectRelative,
  storageName,
  workspaceIdOf,
} from "./paths";

test("a workspace id maps to its storage name and back", () => {
  expect(storageName("abc123")).toBe("sprockt-abc123");
  expect(workspaceIdOf(storageName("abc123"))).toBe("abc123");
});

test("storage that is not a Sprockt workspace has no id", () => {
  expect(workspaceIdOf("waffle-workspace")).toBeUndefined();
  expect(workspaceIdOf("sprockt-")).toBeUndefined();
  expect(workspaceIdOf("sprockt-Not_Valid")).toBeUndefined();
});

test("an invalid id is refused before it reaches storage", () => {
  expect(() => storageName("../escape")).toThrow(TypeError);
  expect(isWorkspaceId("")).toBe(false);
  expect(isWorkspaceId("-leading-dash")).toBe(false);
  expect(isWorkspaceId("a".repeat(64))).toBe(false);
});

test("a new id is valid, and uses the random source it is given", () => {
  expect(isWorkspaceId(newWorkspaceId())).toBe(true);
  expect(newWorkspaceId(() => 0)).toBe("aaaaaaaaaa");
  expect(newWorkspaceId(() => 0.999)).toBe("9999999999");
});

test("a plain relative path maps into the project; anything else is refused", () => {
  expect(projectPath("src/main.ts")).toBe("/workspace/src/main.ts");
  expect(projectPath("a b/ü.txt")).toBe("/workspace/a b/ü.txt");
  for (const bad of ["", "/abs", "..", "a/../b", "a/./b", "a//b", "a/", "a\0"]) {
    expect(() => projectPath(bad)).toThrow(ProjectPathError);
  }
});

test("a link target is resolved against the link's directory", () => {
  expect(linkTarget("/workspace/a/link", "file.txt")).toBe("/workspace/a/file.txt");
  expect(linkTarget("/workspace/a/link", "../b/c")).toBe("/workspace/b/c");
  expect(linkTarget("/workspace/link", "../../etc/passwd")).toBe("/etc/passwd");
  expect(linkTarget("/workspace/link", "/home/guest")).toBe("/home/guest");
  expect(isInsideProject(linkTarget("/workspace/link", ".."))).toBe(false);
  expect(isInsideProject("/workspace-other")).toBe(false);
  expect(isInsideProject("/workspace/x")).toBe(true);
});

test("only paths inside the project have a project-relative form", () => {
  expect(projectRelative("/workspace/src/main.ts")).toBe("src/main.ts");
  expect(projectRelative("/workspace")).toBe("");
  expect(projectRelative("/workspace-other/file")).toBeUndefined();
  expect(projectRelative("/bin/bun")).toBeUndefined();
});
