import { describe, expect, test } from "bun:test";
import {
  createWorkspaceMeta,
  deriveGitHubWorkspaceName,
  deriveUploadFolderName,
  formatRelativeTime,
  isPlaceholderWorkspaceName,
  mergeDerivedWorkspaceName,
  normalizeWorkspaceName,
  packageJsonName,
  parseWorkspaceMeta,
  serializeWorkspaceMeta,
  updateWorkspaceMetaName,
  zipFilename,
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

  test("parses incomplete state, createdAt fallback, and preserves extra fields on rename", () => {
    const imported = parseWorkspaceMeta(
      JSON.stringify({
        name: "bash-web",
        createdAt: "2026-11-25T18:00:00.000Z",
        state: "importing",
        source: { kind: "github", owner: "ShaulLavo", repo: "bash-web", ref: "main" },
      }),
    );
    expect(imported).toEqual({
      name: "bash-web",
      template: "github",
      created: "2026-11-25T18:00:00.000Z",
      lastOpened: "2026-11-25T18:00:00.000Z",
      state: "importing",
      source: { kind: "github", owner: "ShaulLavo", repo: "bash-web", ref: "main", subdir: "" },
    });

    const renamed = updateWorkspaceMetaName(
      JSON.stringify({
        name: "old",
        template: "github",
        created: "2026-11-25T18:00:00.000Z",
        lastOpened: "2026-11-25T18:00:00.000Z",
        detected: { framework: "vite" },
      }),
      "new-name",
    );
    expect(renamed.meta.name).toBe("new-name");
    expect(renamed.meta.defaultName).toBeUndefined();
    expect(JSON.parse(renamed.json)).toMatchObject({
      name: "new-name",
      detected: { framework: "vite" },
    });
  });

  test("derives clean names for GitHub imports, package.json, folder uploads, and ZIP filenames", () => {
    expect(deriveGitHubWorkspaceName("bash-web")).toBe("bash-web");
    expect(deriveGitHubWorkspaceName("demo", "apps/web")).toBe("web");
    expect(deriveGitHubWorkspaceName("demo", "apps/web/")).toBe("web");
    expect(deriveGitHubWorkspaceName("demo", "/")).toBe("demo");

    expect(packageJsonName(JSON.stringify({ name: "my-project" }))).toBe("my-project");
    expect(packageJsonName(new TextEncoder().encode(JSON.stringify({ name: "@scope/pkg" })))).toBe(
      "@scope/pkg",
    );
    expect(packageJsonName(JSON.stringify({ name: "   " }))).toBeUndefined();
    expect(packageJsonName("{invalid")).toBeUndefined();

    expect(
      deriveUploadFolderName([
        { path: "my-app/package.json", hasData: true },
        { path: "my-app/src/index.ts", hasData: true },
      ]),
    ).toBe("my-app");
    expect(deriveUploadFolderName([{ path: "empty-dir", hasData: false }])).toBe("empty-dir");
    expect(deriveUploadFolderName([{ path: "single-file.ts", hasData: true }])).toBeUndefined();
    expect(
      deriveUploadFolderName([
        { path: "a/index.ts", hasData: true },
        { path: "b/index.ts", hasData: true },
      ]),
    ).toBeUndefined();

    expect(zipFilename("bash-web")).toBe("bash-web.zip");
    expect(zipFilename("@shaulavo/bash-web")).toBe("@shaulavo-bash-web.zip");
    expect(zipFilename("///")).toBe("workspace.zip");
  });

  test("falls back to GitHub source when workspace.json lacks a name and only flags explicit placeholders", () => {
    const parsed = parseWorkspaceMeta(
      JSON.stringify({
        created: "2026-11-25T18:00:00.000Z",
        source: { kind: "github", owner: "acme", repo: "mono", ref: "main", subdir: "apps/web" },
      }),
    );
    expect(parsed?.name).toBe("web");

    // Legacy workspace.json without `defaultName` is never treated as a replaceable placeholder.
    const legacyBlank = createWorkspaceMeta({ name: "workspace", template: "blank" });
    expect(isPlaceholderWorkspaceName(legacyBlank)).toBe(false);

    // Newly seeded blank workspaces mark `defaultName: true`; explicit rename clears it.
    const seededBlank = createWorkspaceMeta({ name: "workspace", template: "blank", defaultName: true });
    expect(isPlaceholderWorkspaceName(seededBlank)).toBe(true);
    const explicitRename = updateWorkspaceMetaName(serializeWorkspaceMeta(seededBlank), "workspace");
    expect(isPlaceholderWorkspaceName(explicitRename.meta)).toBe(false);
    expect(JSON.parse(explicitRename.json).defaultName).toBeUndefined();

    const derived = mergeDerivedWorkspaceName(serializeWorkspaceMeta(seededBlank), "cool-app");
    expect(derived.meta.name).toBe("cool-app");
    expect(isPlaceholderWorkspaceName(derived.meta)).toBe(false);
    expect(JSON.parse(derived.json).defaultName).toBeUndefined();

    // Merging onto an incomplete JSON object (missing `created`) fills required fields so it parses back.
    const repaired = mergeDerivedWorkspaceName(
      JSON.stringify({ source: { kind: "share", template: "blank" }, extra: 42 }),
      "recovered-app",
      new Date("2026-11-27T12:00:00.000Z"),
    );
    expect(parseWorkspaceMeta(repaired.json)).toEqual(repaired.meta);
    expect(JSON.parse(repaired.json)).toMatchObject({
      name: "recovered-app",
      template: "blank",
      created: "2026-11-27T12:00:00.000Z",
      lastOpened: "2026-11-27T12:00:00.000Z",
      extra: 42,
    });

    // Renaming partial metadata missing `created` preserves valid `template`, `lastOpened`, `state`, and `source`.
    const partialRenamed = updateWorkspaceMetaName(
      JSON.stringify({
        name: "old",
        template: "github",
        lastOpened: "2026-11-20T08:00:00.000Z",
        state: "importing",
        source: { kind: "github", owner: "acme", repo: "demo", ref: "main", subdir: "" },
      }),
      "renamed",
      new Date("2026-11-27T12:00:00.000Z"),
    );
    expect(partialRenamed.meta).toEqual({
      name: "renamed",
      template: "github",
      created: "2026-11-27T12:00:00.000Z",
      lastOpened: "2026-11-20T08:00:00.000Z",
      state: "importing",
      source: { kind: "github", owner: "acme", repo: "demo", ref: "main", subdir: "" },
    });
    expect(parseWorkspaceMeta(partialRenamed.json)).toEqual(partialRenamed.meta);
  });
});
