import { describe, expect, test } from "bun:test";
import { writeFiles } from "../../lib/fs/entries.ts";
import { MemoryFs } from "../../lib/fs/memory.ts";
import { textEncoder } from "../../lib/bytes.ts";
import { detectProject, detectProjectInFs, type ProjectDetection } from "./detect.ts";

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
      dev: { command: "bun", args: ["--hot", "server.ts"] },
      port: 8000,
    });
  });

  test("Bun.serve default port and export-default fetch handlers", () => {
    expect(
      detect({ "src/index.ts": "export default { fetch(req) { return new Response('x') } }" }),
    ).toMatchObject({
      framework: "bun-serve",
      dev: { command: "bun", args: ["--hot", "src/index.ts"] },
      port: 3000,
    });
  });

  test("Hono without a dev script runs its entry file", () => {
    const result = detect({ "package.json": pkg({}, { hono: "4" }), "src/index.ts": "export default app" });
    expect(result.dev).toEqual({ command: "bun", args: ["--hot", "src/index.ts"] });
    expect(result.port).toBe(3000);
  });

  test("package.json module field names the entry", () => {
    const result = detect({
      "package.json": { module: "./app/main.ts" },
      "app/main.ts": "Bun.serve({ port: 9000, fetch: () => new Response() })",
    });
    expect(result.dev).toEqual({ command: "bun", args: ["--hot", "app/main.ts"] });
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
    expect((await detectProjectInFs(fs)).dev).toEqual({ command: "bun", args: ["--hot", "src/server.ts"] });
  });
});
