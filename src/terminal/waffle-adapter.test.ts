import { describe, expect, it } from "bun:test";
import { normalizeTerminalLinkPath } from "./waffle-adapter";

describe("normalizeTerminalLinkPath", () => {
  it("normalizes project-relative, dot-relative, and /workspace paths", () => {
    expect(normalizeTerminalLinkPath("src/App.tsx")).toBe("src/App.tsx");
    expect(normalizeTerminalLinkPath("./src/App.tsx")).toBe("src/App.tsx");
    expect(normalizeTerminalLinkPath("././Makefile")).toBe("Makefile");
    expect(normalizeTerminalLinkPath("/workspace/src/App.tsx")).toBe("src/App.tsx");
    expect(normalizeTerminalLinkPath("/workspace/Makefile")).toBe("Makefile");
  });

  it("rejects paths outside the project, traversals, directories, and empty strings", () => {
    expect(normalizeTerminalLinkPath("")).toBeUndefined();
    expect(normalizeTerminalLinkPath("/workspace")).toBeUndefined();
    expect(normalizeTerminalLinkPath("/workspace/")).toBeUndefined();
    expect(normalizeTerminalLinkPath("/etc/passwd")).toBeUndefined();
    expect(normalizeTerminalLinkPath("../outside.ts")).toBeUndefined();
    expect(normalizeTerminalLinkPath("src/../outside.ts")).toBeUndefined();
    expect(normalizeTerminalLinkPath("src/./App.tsx")).toBeUndefined();
    expect(normalizeTerminalLinkPath("src/")).toBeUndefined();
  });
});
