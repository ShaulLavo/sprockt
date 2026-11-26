import { describe, expect, test } from "bun:test";
import { ALL_TEMPLATES, BLANK_TEMPLATE, findTemplate, STARTER_TEMPLATES, templateLabel } from "./catalog";

function assertSafeStarterDeps(id: string, pkgText: string | undefined): void {
  const pkg = JSON.parse(pkgText ?? "{}") as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  expect(allDeps.rolldown, `${id} must not depend on rolldown`).toBeUndefined();
  if (allDeps.vite) {
    const [major, minor, patch] = allDeps.vite
      .replace(/^[^\d]*/, "")
      .split(".")
      .map(Number);
    expect(major, `${id} vite major must stay < 8`).toBeLessThan(8);
    // GHSA-p4f5-76q4-ffq7 patched in Vite 7.3.2+.
    const safeVite7 = major !== 7 || (minor ?? 0) > 3 || (minor === 3 && (patch ?? 0) >= 2);
    expect(safeVite7, `${id} vite 7 pin must be >= 7.3.2`).toBe(true);
  }
  if (allDeps["@vitejs/plugin-react"]) {
    const major = Number(allDeps["@vitejs/plugin-react"].replace(/^[^\d]*/, "").split(".")[0]);
    expect(major, `${id} @vitejs/plugin-react major must stay < 6`).toBeLessThan(6);
  }
}

function isSafeRelativePath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

describe("template catalog", () => {
  test("includes all seven starter templates plus blank", () => {
    expect(STARTER_TEMPLATES.map((template) => template.id)).toEqual([
      "vite-react",
      "next-app",
      "hono",
      "astro",
      "sveltekit",
      "vanilla",
      "bun-sqlite",
    ]);
    expect(ALL_TEMPLATES).toContain(BLANK_TEMPLATE);
  });

  test("every starter template has valid paths, package.json with dev script, and editorFile", () => {
    for (const template of STARTER_TEMPLATES) {
      const paths = Object.keys(template.files);
      expect(paths.length).toBeGreaterThan(0);
      for (const path of paths) {
        expect(isSafeRelativePath(path)).toBe(true);
      }
      expect(template.editorFile).toBeDefined();
      if (template.editorFile) {
        expect(template.files[template.editorFile]).toBeDefined();
      }
      const pkgText = template.files["package.json"];
      expect(pkgText).toBeDefined();
      const pkg = JSON.parse(pkgText ?? "{}") as { scripts?: Record<string, string> };
      expect(typeof pkg.scripts?.dev).toBe("string");
      expect(pkg.scripts?.dev?.trim().length).toBeGreaterThan(0);
    }
  });

  test("every starter with TypeScript sources ships a tsconfig.json for the editor's checker", () => {
    for (const template of ALL_TEMPLATES) {
      const paths = Object.keys(template.files);
      if (!paths.some((path) => /\.tsx?$/.test(path))) continue;
      expect({ id: template.id, tsconfig: paths.includes("tsconfig.json") }).toEqual({
        id: template.id,
        tsconfig: true,
      });
    }
  });

  test("bun-sqlite template uses bun:sqlite and Bun.serve with no package dependencies, only Bun's types", () => {
    const sqlite = findTemplate("bun-sqlite");
    expect(sqlite).toBeDefined();
    const pkg = JSON.parse(sqlite?.files["package.json"] ?? "{}") as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.dependencies).toBeUndefined();
    expect(Object.keys(pkg.devDependencies ?? {})).toEqual(["@types/bun"]);
    expect(sqlite?.files["server.ts"]).toContain('from "bun:sqlite"');
    expect(sqlite?.files["server.ts"]).toContain("Bun.serve");
  });

  test("next-app template pins a Next.js 15.5 release patched for CVE-2025-66478 with matching swc-wasm", () => {
    const nextApp = findTemplate("next-app");
    expect(nextApp).toBeDefined();
    const pkg = JSON.parse(nextApp?.files["package.json"] ?? "{}") as {
      dependencies?: Record<string, string>;
    };
    const nextVersion = pkg.dependencies?.next ?? "";
    const swcVersion = pkg.dependencies?.["@next/swc-wasm-nodejs"] ?? "";
    const [major, minor, patch] = nextVersion.split(".").map(Number);
    expect(major).toBe(15);
    expect(minor).toBe(5);
    expect(patch).toBeGreaterThanOrEqual(7);
    expect(swcVersion).toBe(nextVersion);
  });

  test("no starter template pins Vite 8+, Rolldown, unpatched Vite 7, or @vitejs/plugin-react 6+", () => {
    for (const template of STARTER_TEMPLATES) {
      assertSafeStarterDeps(template.id, template.files["package.json"]);
    }
  });

  test("astro template disables telemetry in dev and build scripts", () => {
    const astro = findTemplate("astro");
    const pkg = JSON.parse(astro?.files["package.json"] ?? "{}") as { scripts?: Record<string, string> };
    expect(pkg.scripts?.dev).toContain("ASTRO_TELEMETRY_DISABLED=1");
    expect(pkg.scripts?.build).toContain("ASTRO_TELEMETRY_DISABLED=1");
  });

  test("blank template starts with no files", () => {
    expect(Object.keys(BLANK_TEMPLATE.files)).toEqual([]);
  });

  test("lookup and label helpers cover known and fallback ids", () => {
    expect(findTemplate("hono")?.label).toBe("Hono");
    expect(findTemplate("unknown")).toBeUndefined();
    expect(templateLabel("vite-react")).toBe("Vite + React");
    expect(templateLabel("github")).toBe("GitHub");
    expect(templateLabel("custom")).toBe("Workspace");
  });
});
