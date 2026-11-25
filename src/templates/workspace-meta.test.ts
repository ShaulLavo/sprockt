import { describe, expect, test } from "bun:test";
import {
  createWorkspaceMeta,
  formatRelativeTime,
  normalizeWorkspaceName,
  parseWorkspaceMeta,
  serializeWorkspaceMeta,
} from "./workspace-meta";

describe("workspace metadata", () => {
  test("creates, serializes, and parses workspace.json cleanly", () => {
    const now = new Date("2026-11-25T18:00:00.000Z");
    const meta = createWorkspaceMeta({ name: "  my   app  ", template: "vite-react", now });
    expect(meta).toEqual({
      name: "my app",
      template: "vite-react",
      created: "2026-11-25T18:00:00.000Z",
      lastOpened: "2026-11-25T18:00:00.000Z",
    });
    expect(parseWorkspaceMeta(serializeWorkspaceMeta(meta))).toEqual(meta);
  });

  test("rejects malformed or incomplete metadata", () => {
    expect(parseWorkspaceMeta("{broken")).toBeUndefined();
    expect(parseWorkspaceMeta("[]")).toBeUndefined();
    expect(
      parseWorkspaceMeta(JSON.stringify({ name: "   ", created: "2026-11-25T00:00:00Z" })),
    ).toBeUndefined();
    expect(parseWorkspaceMeta(JSON.stringify({ name: "app" }))).toBeUndefined();
  });

  test("normalizes names and truncates long input", () => {
    expect(normalizeWorkspaceName("   ")).toBeUndefined();
    expect(normalizeWorkspaceName("  hello\t\nworld  ")).toBe("hello world");
    expect(normalizeWorkspaceName("a".repeat(80))?.length).toBe(64);
  });

  test("formats relative timestamps across ranges", () => {
    const now = new Date("2026-11-25T18:00:00.000Z");
    expect(formatRelativeTime("2026-11-25T17:59:40.000Z", now)).toBe("Just now");
    expect(formatRelativeTime("2026-11-25T17:45:00.000Z", now)).toBe("15 m ago");
    expect(formatRelativeTime("2026-11-25T16:00:00.000Z", now)).toBe("2 h ago");
    expect(formatRelativeTime("2026-11-24T12:00:00.000Z", now)).toBe("Yesterday");
    expect(formatRelativeTime("2026-11-22T12:00:00.000Z", now)).toBe("3 d ago");
    expect(formatRelativeTime("2026-11-10T12:00:00.000Z", now)).toBe("Nov 10");
    expect(formatRelativeTime("not-a-date", now)).toBe("");
  });
});
