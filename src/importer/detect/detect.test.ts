import { describe, expect, test } from "bun:test";
import { writeFiles } from "../../lib/fs/entries.ts";
import { MemoryFs } from "../../lib/fs/memory.ts";
import { textEncoder } from "../../lib/bytes.ts";
import {
  detectProject,
  detectProjectInFs,
  detectProjectTargets,
  detectProjectTargetsInFs,
  type ProjectDetection,
} from "./detect.ts";

function detect(files: Record<string, string | object>): ProjectDetection {
  const texts = new Map(
    Object.entries(files).map(([path, value]) => [
      path,
      typeof value === "string" ? value : JSON.stringify(value),
    ]),
  );
  return detectProject({ paths: texts.keys(), read: (path) => texts.get(path) });
}

const pkg = (
  scripts: Record<string, string>,
  deps: Record<string, string> = {},
  devDeps: Record<string, string> = {},
) => ({
  scripts,
  dependencies: deps,
  devDependencies: devDeps,
});

describe("detectProject", () => {
  test("Vite with a dev script and a bun lockfile", () => {
    const result = detect({ "package.json": pkg({ dev: "vite" }, {}, { vite: "^7" }), "bun.lock": "" });
    expect(result).toEqual({
      hasPackageJson: true,
      packageManager: "bun",
      lockfile: "bun.lock",
      framework: "vite",
      install: { command: "bun", args: ["install"] },
      devScript: "dev",
      dev: { command: "bun", args: ["run", "dev"] },
      port: 5173,
    });
  });

  test.each([
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
    ["bun.lockb", "bun"],
  ])("lockfile %s means %s, and install is still bun install", (lockfile, manager) => {
    const result = detect({ "package.json": pkg({ dev: "vite" }), [lockfile]: "" });
    expect(result.packageManager).toBe(manager as ProjectDetection["packageManager"]);
    expect(result.lockfile).toBe(lockfile);
    expect(result.install).toEqual({ command: "bun", args: ["install"] });
  });

  test.each([
    [{ next: "15" }, { dev: "next dev" }, "next", 3000],
    [{ nuxt: "3" }, { dev: "nuxt dev" }, "nuxt", 3000],
    [{ astro: "5" }, { dev: "astro dev" }, "astro", 4321],
    [{ "@sveltejs/kit": "2", vite: "7" }, { dev: "vite dev" }, "sveltekit", 5173],
    [{ "@react-router/dev": "7", vite: "7" }, { dev: "react-router dev" }, "react-router", 5173],
    [{ "@remix-run/dev": "2", vite: "5" }, { dev: "remix vite:dev" }, "remix", 5173],
    [{ hono: "4" }, { dev: "bun run --hot src/index.ts" }, "hono", 3000],
  ] as const)("framework from dependencies %o", (deps, scripts, framework, port) => {
    const result = detect({ "package.json": pkg(scripts, deps) });
    expect(result.framework).toBe(framework);
    expect(result.port).toBe(port);
    expect(result.dev).toEqual({ command: "bun", args: ["run", "dev"] });
  });

  test("falls back from dev to start to serve", () => {
    expect(detect({ "package.json": pkg({ start: "node x", serve: "y" }) }).devScript).toBe("start");
    expect(detect({ "package.json": pkg({ serve: "vite preview", build: "vite build" }) }).devScript).toBe(
      "serve",
    );
  });

  test("framework defaults when there is no dev script", () => {
    expect(detect({ "package.json": pkg({}, { next: "15" }) }).dev).toEqual({
      command: "bunx",
      args: ["next", "dev"],
    });
    expect(detect({ "package.json": pkg({}, {}, { vite: "7" }) }).dev).toEqual({
      command: "bunx",
      args: ["vite"],
    });
    expect(detect({ "package.json": pkg({}, { nuxt: "3" }) }).dev).toEqual({
      command: "bunx",
      args: ["nuxi", "dev"],
    });
    expect(detect({ "package.json": pkg({}, { astro: "5" }) }).dev).toEqual({
      command: "bunx",
      args: ["astro", "dev"],
    });
  });

  test("framework from the dev script when dependencies do not say", () => {
    const result = detect({ "package.json": pkg({ dev: "NODE_ENV=development bunx --bun vite --host" }) });
    expect(result.framework).toBe("vite");
  });

  test("ports from script flags and the Vite server config", () => {
    expect(detect({ "package.json": pkg({ dev: "next dev -p 4000" }, { next: "15" }) }).port).toBe(4000);
    expect(detect({ "package.json": pkg({ dev: "vite --port=8080" }, { vite: "7" }) }).port).toBe(8080);
    expect(detect({ "package.json": pkg({ dev: "astro dev --port 1234" }, { astro: "5" }) }).port).toBe(1234);
    const vite = detect({
      "package.json": pkg({ dev: "vite" }, {}, { vite: "7" }),
      "vite.config.ts": "export default { preview: { port: 4173 }, server: { host: true, port: 3333 } }",
    });
    expect(vite.port).toBe(3333);
    const nested = detect({
      "package.json": pkg({ dev: "vite" }, {}, { vite: "7" }),
      "vite.config.ts":
        "export default defineConfig({ server: { hmr: { port: 24678, overlay: false }, port: 4321 } })",
    });
    expect(nested.port).toBe(4321);
    const hmrOnly = detect({
      "package.json": pkg({ dev: "vite" }, {}, { vite: "7" }),
      "vite.config.ts": "export default { server: { hmr: { port: 24678 } } }",
    });
    expect(hmrOnly.port).toBe(5173);
  });

  test("reads a package.json saved with a BOM", () => {
    const result = detect({ "package.json": `﻿${JSON.stringify(pkg({ dev: "next dev" }, { next: "15" }))}` });
    expect(result.framework).toBe("next");
  });

  test("plain Bun.serve without package.json", () => {
    const result = detect({
      "server.ts": "Bun.serve({ port: 8000, fetch() { return new Response('hi') } })",
    });
    expect(result).toMatchObject({
      hasPackageJson: false,
      framework: "bun-serve",
      install: undefined,
      dev: { command: "bun", args: ["server.ts"] },
      port: 8000,
    });
  });

  test("Bun.serve default port and export-default fetch handlers", () => {
    expect(
      detect({ "src/index.ts": "export default { fetch(req) { return new Response('x') } }" }),
    ).toMatchObject({
      framework: "bun-serve",
      dev: { command: "bun", args: ["src/index.ts"] },
      port: 3000,
    });
  });

  test("Hono without a dev script runs its entry file", () => {
    const result = detect({ "package.json": pkg({}, { hono: "4" }), "src/index.ts": "export default app" });
    expect(result.dev).toEqual({ command: "bun", args: ["src/index.ts"] });
    expect(result.port).toBe(3000);
  });

  test("package.json module field names the entry", () => {
    const result = detect({
      "package.json": { module: "./app/main.ts" },
      "app/main.ts": "Bun.serve({ port: 9000, fetch: () => new Response() })",
    });
    expect(result.dev).toEqual({ command: "bun", args: ["app/main.ts"] });
    expect(result.port).toBe(9000);
  });

  test("nothing runnable", () => {
    expect(detect({ "README.md": "# hi" })).toMatchObject({
      framework: undefined,
      dev: undefined,
      port: undefined,
      install: undefined,
    });
    expect(detect({ "package.json": "{not json" })).toMatchObject({ hasPackageJson: true, dev: undefined });
  });
});

describe("detectProjectInFs", () => {
  test("reads only what it needs from a filesystem", async () => {
    const fs = new MemoryFs();
    await writeFiles(
      fs,
      Object.entries({
        "package.json": JSON.stringify(pkg({ dev: "vite" }, {}, { vite: "7" })),
        "vite.config.ts": "export default { server: { port: 5000 } }",
        "pnpm-lock.yaml": "",
        "src/main.ts": "",
      }).map(([path, text]) => ({ path, bytes: textEncoder.encode(text) })),
      "project",
    );
    const result = await detectProjectInFs(fs, "project");
    expect(result).toMatchObject({ framework: "vite", packageManager: "pnpm", port: 5000, devScript: "dev" });
  });

  test("reads the entry package.json names, wherever it is", async () => {
    const fs = new MemoryFs();
    await writeFiles(fs, [
      { path: "package.json", bytes: textEncoder.encode(JSON.stringify({ main: "app/server/main.ts" })) },
      { path: "app/server/main.ts", bytes: textEncoder.encode("Bun.serve({ port: 7000, fetch() {} })") },
    ]);
    expect(await detectProjectInFs(fs)).toMatchObject({ framework: "bun-serve", port: 7000 });
    await fs.writeFile("package.json", textEncoder.encode(JSON.stringify({ main: "../../etc/passwd" })));
    expect((await detectProjectInFs(fs)).framework).toBeUndefined();
  });

  test("finds a Bun.serve entry under src", async () => {
    const fs = new MemoryFs();
    await writeFiles(fs, [{ path: "src/server.ts", bytes: textEncoder.encode("Bun.serve({ fetch() {} })") }]);
    expect((await detectProjectInFs(fs)).dev).toEqual({ command: "bun", args: ["src/server.ts"] });
  });

  test("discovers monorepo targets from package.json workspaces and pnpm-workspace.yaml", async () => {
    const fs = new MemoryFs();
    await writeFiles(fs, [
      {
        path: "package.json",
        bytes: textEncoder.encode(
          JSON.stringify({
            name: "mono",
            private: true,
            workspaces: { packages: ["apps/*", "packages/*", "!packages/ignored"] },
          }),
        ),
      },
      {
        path: "apps/web/package.json",
        bytes: textEncoder.encode(
          JSON.stringify({ name: "@mono/web", scripts: { dev: "vite" }, devDependencies: { vite: "7" } }),
        ),
      },
      {
        path: "apps/web/vite.config.ts",
        bytes: textEncoder.encode("export default { server: { port: 5174 } }"),
      },
      {
        path: "apps/api/package.json",
        bytes: textEncoder.encode(
          JSON.stringify({ name: "@mono/api", scripts: { dev: "bun run server.ts -p 3102" } }),
        ),
      },
      {
        path: "packages/ignored/package.json",
        bytes: textEncoder.encode(JSON.stringify({ name: "ignored", scripts: { dev: "vite" } })),
      },
    ]);

    const result = await detectProjectTargetsInFs(fs);
    expect(result.targets.map((t) => ({ id: t.id, name: t.name, port: t.port, dir: t.dir }))).toEqual([
      { id: "apps/api:dev", name: "@mono/api", port: 3102, dir: "apps/api" },
      { id: "apps/web:dev", name: "@mono/web", port: 5174, dir: "apps/web" },
    ]);
    // Root has no dev script, so fallback picks the Vite app in apps/web and exposes its id.
    expect(result.defaultTargetId).toBe("apps/web:dev");
    expect(result.detection).toMatchObject({
      hasPackageJson: true,
      framework: "vite",
      devScript: "dev",
      dev: { command: "bun", args: ["run", "--cwd", "apps/web", "dev"] },
      port: 5174,
    });

    // Also supports pnpm-workspace.yaml with quoted entries and comments.
    const pnpm = detectProjectTargets({
      paths: ["package.json", "pnpm-workspace.yaml", "apps/site/package.json"],
      read: (path) => {
        if (path === "package.json") return JSON.stringify({ name: "pnpm-mono" });
        if (path === "pnpm-workspace.yaml") return 'packages:\n  - "apps/*" # apps\n  - "!apps/skip"\n';
        if (path === "apps/site/package.json") {
          return JSON.stringify({ name: "site", scripts: { dev: "astro dev", start: "astro preview" } });
        }
        return undefined;
      },
    });
    expect(pnpm.targets.map((t) => t.id)).toEqual(["apps/site:dev", "apps/site:start"]);
    expect(pnpm.defaultTargetId).toBe("apps/site:dev");
    expect(pnpm.detection.dev).toEqual({ command: "bun", args: ["run", "--cwd", "apps/site", "dev"] });
    expect(pnpm.detection.port).toBe(4321);
  });

  test("prefers workspace apps over inferred root framework devDependencies", async () => {
    const fs = new MemoryFs();
    await writeFiles(fs, [
      {
        path: "package.json",
        bytes: textEncoder.encode(
          JSON.stringify({
            name: "mono",
            private: true,
            workspaces: ["apps/*"],
            devDependencies: { vite: "^7" },
          }),
        ),
      },
      {
        path: "apps/web/package.json",
        bytes: textEncoder.encode(JSON.stringify({ name: "web", scripts: { dev: "vite --port 5175" } })),
      },
    ]);
    const result = await detectProjectTargetsInFs(fs);
    expect(result.defaultTargetId).toBe("apps/web:dev");
    expect(result.detection).toMatchObject({
      framework: "vite",
      devScript: "dev",
      dev: { command: "bun", args: ["run", "--cwd", "apps/web", "dev"] },
      port: 5175,
    });
  });

  test("includes a runnable root server entry alongside workspace apps in targets", async () => {
    const fs = new MemoryFs();
    await writeFiles(fs, [
      {
        path: "package.json",
        bytes: textEncoder.encode(JSON.stringify({ name: "mono", workspaces: ["apps/*"] })),
      },
      {
        path: "server.ts",
        bytes: textEncoder.encode("Bun.serve({ port: 3000, fetch: () => new Response('root') })"),
      },
      {
        path: "apps/web/package.json",
        bytes: textEncoder.encode(JSON.stringify({ name: "web", scripts: { dev: "vite" } })),
      },
    ]);
    const result = await detectProjectTargetsInFs(fs);
    expect(result.targets.map((t) => t.id)).toEqual(["entry:server.ts", "apps/web:dev"]);
    expect(result.defaultTargetId).toBe("entry:server.ts");
    expect(result.targets[0]?.bareEntry).toBe(true);
    expect(result.detection.dev).toEqual({ command: "bun", args: ["server.ts"] });
  });

  test("supports deep explicit workspace paths, brace/class/? globs, and order-independent exclusions", async () => {
    const fs = new MemoryFs();
    await writeFiles(fs, [
      {
        path: "package.json",
        bytes: textEncoder.encode(
          JSON.stringify({
            name: "deep-mono",
            workspaces: [
              "!apps/skip",
              "apps/frontends/customer/web",
              "{apps,packages}/[a-s]*",
              "tools/cli-?",
            ],
          }),
        ),
      },
      {
        path: "apps/frontends/customer/web/package.json",
        bytes: textEncoder.encode(JSON.stringify({ name: "customer-web", scripts: { dev: "vite" } })),
      },
      {
        path: "apps/skip/package.json",
        bytes: textEncoder.encode(JSON.stringify({ name: "skip", scripts: { dev: "vite" } })),
      },
      {
        path: "packages/admin/package.json",
        bytes: textEncoder.encode(JSON.stringify({ name: "admin", scripts: { dev: "vite" } })),
      },
      {
        path: "packages/zebra/package.json",
        bytes: textEncoder.encode(JSON.stringify({ name: "zebra", scripts: { dev: "vite" } })),
      },
      {
        path: "tools/cli-1/package.json",
        bytes: textEncoder.encode(JSON.stringify({ name: "cli-1", scripts: { start: "bun index.ts" } })),
      },
      {
        path: "tools/cli-10/package.json",
        bytes: textEncoder.encode(JSON.stringify({ name: "cli-10", scripts: { start: "bun index.ts" } })),
      },
    ]);

    const result = await detectProjectTargetsInFs(fs);
    expect(result.targets.map((t) => t.dir)).toEqual([
      "apps/frontends/customer/web",
      "packages/admin",
      "tools/cli-1",
    ]);
    expect(result.defaultTargetId).toBe("apps/frontends/customer/web:dev");
  });

  test("preserves literal workspace inclusions even when matched by wildcard exclusions", async () => {
    const files: Record<string, string> = {
      "package.json": JSON.stringify({
        name: "mono",
        workspaces: ["packages/**", "!**/test/**", "packages/test/demo"],
      }),
      "packages/test/demo/package.json": JSON.stringify({ name: "demo", scripts: { dev: "bun server.ts" } }),
      "packages/test/other/package.json": JSON.stringify({
        name: "other",
        scripts: { dev: "bun server.ts" },
      }),
      "packages/ui/package.json": JSON.stringify({ name: "ui", scripts: { dev: "vite" } }),
    };
    const fromPaths = detectProjectTargets({ paths: Object.keys(files), read: (path) => files[path] });
    expect(fromPaths.targets.map((t) => t.dir)).toEqual(["packages/test/demo", "packages/ui"]);

    const fs = new MemoryFs();
    await writeFiles(
      fs,
      Object.entries(files).map(([path, content]) => ({ path, bytes: textEncoder.encode(content) })),
    );
    const fromFs = await detectProjectTargetsInFs(fs);
    expect(fromFs.targets.map((t) => t.dir)).toEqual(["packages/test/demo", "packages/ui"]);
  });

  test("preserves commas inside quoted inline pnpm-workspace.yaml patterns", async () => {
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ name: "pnpm-mono" }),
      "pnpm-workspace.yaml": "packages: [\"{apps,packages}/*\", 'tools/cli']\n",
      "apps/web/package.json": JSON.stringify({ name: "web", scripts: { dev: "vite" } }),
      "packages/ui/package.json": JSON.stringify({ name: "ui", scripts: { dev: "bun server.ts" } }),
      "tools/cli/package.json": JSON.stringify({ name: "cli", scripts: { start: "bun index.ts" } }),
    };
    const fromPaths = detectProjectTargets({ paths: Object.keys(files), read: (path) => files[path] });
    expect(fromPaths.targets.map((t) => t.dir)).toEqual(["apps/web", "packages/ui", "tools/cli"]);
    expect(fromPaths.defaultTargetId).toBe("apps/web:dev");

    const fs = new MemoryFs();
    await writeFiles(
      fs,
      Object.entries(files).map(([path, content]) => ({ path, bytes: textEncoder.encode(content) })),
    );
    const fromFs = await detectProjectTargetsInFs(fs);
    expect(fromFs.targets.map((t) => t.dir)).toEqual(["apps/web", "packages/ui", "tools/cli"]);
    expect(fromFs.defaultTargetId).toBe("apps/web:dev");
  });

  test("excludes hidden path segments from ordinary workspace wildcards unless explicitly matched", async () => {
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ name: "mono", workspaces: ["apps/*", "packages/**"] }),
      "apps/.template/package.json": JSON.stringify({ name: "template", scripts: { dev: "bun server.ts" } }),
      "apps/web/package.json": JSON.stringify({ name: "web", scripts: { dev: "bun server.ts" } }),
      "packages/.hidden/app/package.json": JSON.stringify({
        name: "hidden-app",
        scripts: { dev: "bun server.ts" },
      }),
      "packages/public/package.json": JSON.stringify({ name: "public", scripts: { dev: "bun server.ts" } }),
    };
    const fromPaths = detectProjectTargets({ paths: Object.keys(files), read: (path) => files[path] });
    expect(fromPaths.targets.map((t) => t.dir)).toEqual(["apps/web", "packages/public"]);
    expect(fromPaths.defaultTargetId).toBe("apps/web:dev");

    const fs = new MemoryFs();
    await writeFiles(
      fs,
      Object.entries(files).map(([path, content]) => ({ path, bytes: textEncoder.encode(content) })),
    );
    const fromFs = await detectProjectTargetsInFs(fs);
    expect(fromFs.targets.map((t) => t.dir)).toEqual(["apps/web", "packages/public"]);
    expect(fromFs.defaultTargetId).toBe("apps/web:dev");

    // Explicit leading-dot patterns still match hidden directories.
    const explicit = detectProjectTargets({
      paths: Object.keys(files),
      read: (path) =>
        path === "package.json" ? JSON.stringify({ name: "mono", workspaces: ["apps/.*"] }) : files[path],
    });
    expect(explicit.targets.map((t) => t.dir)).toEqual(["apps/.template"]);
  });

  test("allows negative globs to exclude packages inside explicitly included hidden directories", async () => {
    const files: Record<string, string> = {
      "package.json": JSON.stringify({
        name: "mono",
        workspaces: ["apps/.examples/*", "!**/legacy"],
      }),
      "apps/.examples/legacy/package.json": JSON.stringify({
        name: "legacy",
        scripts: { dev: "bun server.ts" },
      }),
      "apps/.examples/web/package.json": JSON.stringify({ name: "web", scripts: { dev: "bun server.ts" } }),
    };
    const fromPaths = detectProjectTargets({ paths: Object.keys(files), read: (path) => files[path] });
    expect(fromPaths.targets.map((t) => t.dir)).toEqual(["apps/.examples/web"]);
    expect(fromPaths.defaultTargetId).toBe("apps/.examples/web:dev");

    const fs = new MemoryFs();
    await writeFiles(
      fs,
      Object.entries(files).map(([path, content]) => ({ path, bytes: textEncoder.encode(content) })),
    );
    const fromFs = await detectProjectTargetsInFs(fs);
    expect(fromFs.targets.map((t) => t.dir)).toEqual(["apps/.examples/web"]);
    expect(fromFs.defaultTargetId).toBe("apps/.examples/web:dev");
  });

  test("ignores invalid workspace globs and treats escaped wildcards literally", async () => {
    const files: Record<string, string> = {
      "package.json": JSON.stringify({
        name: "root-app",
        scripts: { dev: "bun server.ts" },
        workspaces: ["apps/[z-a]", "apps/foo\\*"],
      }),
      "apps/fo/package.json": JSON.stringify({ name: "fo", scripts: { dev: "bun server.ts" } }),
      "apps/foo/package.json": JSON.stringify({ name: "foo", scripts: { dev: "bun server.ts" } }),
    };
    const fromPaths = detectProjectTargets({ paths: Object.keys(files), read: (path) => files[path] });
    expect(fromPaths.detection.devScript).toBe("dev");
    expect(fromPaths.targets.map((t) => t.id)).toEqual(["dev"]);

    const fs = new MemoryFs();
    await writeFiles(
      fs,
      Object.entries(files).map(([path, content]) => ({ path, bytes: textEncoder.encode(content) })),
    );
    const fromFs = await detectProjectTargetsInFs(fs);
    expect(fromFs.detection.devScript).toBe("dev");
    expect(fromFs.targets.map((t) => t.id)).toEqual(["dev"]);
  });

  test("discovers deep globstar workspaces consistently in both path-based and filesystem detection", async () => {
    const deepDir = "packages/a/b/c/d/e/f/g/h/i/j/k/m"; // 13 segments deep
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ name: "mono", workspaces: ["packages/**"] }),
      [`${deepDir}/package.json`]: JSON.stringify({ name: "deep", scripts: { dev: "bun server.ts" } }),
    };
    const fromPaths = detectProjectTargets({ paths: Object.keys(files), read: (path) => files[path] });
    const fs = new MemoryFs();
    await writeFiles(
      fs,
      Object.entries(files).map(([path, content]) => ({ path, bytes: textEncoder.encode(content) })),
    );
    const fromFs = await detectProjectTargetsInFs(fs);
    expect(fromPaths.targets.map((t) => t.dir)).toEqual([deepDir]);
    expect(fromFs.targets.map((t) => t.dir)).toEqual([deepDir]);
    expect(fromPaths.defaultTargetId).toBe(`${deepDir}:dev`);
    expect(fromFs.defaultTargetId).toBe(`${deepDir}:dev`);
  });

  test("evaluates multi-globstar patterns on deep paths in linear time without backtracking", async () => {
    const segs = Array.from({ length: 24 }, () => "a").join("/");
    const matched = `packages/${segs}/app`;
    const unmatched = `packages/${segs}/other`;
    const files: Record<string, string> = {
      "package.json": JSON.stringify({
        name: "mono",
        workspaces: ["packages/**/**/a/**/a/**/a/**/a/**/app"],
      }),
      [`${matched}/package.json`]: JSON.stringify({ name: "app", scripts: { dev: "bun server.ts" } }),
      [`${unmatched}/package.json`]: JSON.stringify({ name: "other", scripts: { dev: "bun server.ts" } }),
    };
    const fromPaths = detectProjectTargets({ paths: Object.keys(files), read: (path) => files[path] });
    const fs = new MemoryFs();
    await writeFiles(
      fs,
      Object.entries(files).map(([path, content]) => ({ path, bytes: textEncoder.encode(content) })),
    );
    const fromFs = await detectProjectTargetsInFs(fs);
    expect(fromPaths.targets.map((t) => t.dir)).toEqual([matched]);
    expect(fromFs.targets.map((t) => t.dir)).toEqual([matched]);
  });
});
