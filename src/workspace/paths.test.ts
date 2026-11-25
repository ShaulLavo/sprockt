import { expect, test } from "bun:test";
import { isWorkspaceId, newWorkspaceId, projectRelative, storageName, workspaceIdOf } from "./paths";

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

test("only paths inside the project have a project-relative form", () => {
  expect(projectRelative("/workspace/src/main.ts")).toBe("src/main.ts");
  expect(projectRelative("/workspace")).toBe("");
  expect(projectRelative("/workspace-other/file")).toBeUndefined();
  expect(projectRelative("/bin/bun")).toBeUndefined();
});
