import { expect, test } from "bun:test";
import { detectProject, detectProjectTargets } from "../importer/detect/detect";
import { devStart, devStartForTarget, entriesOf } from "./detect";

function detected(files: Record<string, string>) {
  return detectProject({ paths: Object.keys(files), read: (path) => files[path] });
}

const manifest = (scripts: Record<string, string>) => JSON.stringify({ name: "app", scripts });
const SERVER = "Bun.serve({ port: 3000, fetch: () => new Response('ok') });";

test("a project with a dev script runs it, installing first only when nothing is installed", () => {
  const project = detected({ "package.json": manifest({ dev: "vite" }) });
  expect(devStart(project, false)?.script).toBe("bun install && bun run dev");
  expect(devStart(project, true)?.script).toBe("bun run dev");
  // A dev script reloads the way its author chose: the task does not run it again.
  expect(devStart(project, false)?.rerun).toBeUndefined();
});

test("a server file without package.json is run as it is, and again when the source changes", () => {
  const project = detected({ "server.ts": SERVER });
  // No `--hot`: bun-wasm refuses it for a file like this one, which has no import or export.
  expect(devStart(project, false)).toEqual({ script: "bun server.ts", rerun: "bun server.ts" });
});

test("an entry file beside a package.json installs once and then runs only the file again", () => {
  const project = detected({ "package.json": manifest({ test: "bun test" }), "server.ts": SERVER });
  expect(devStart(project, false)).toEqual({
    script: "bun install && bun server.ts",
    rerun: "bun server.ts",
  });
  expect(devStart(project, true)).toEqual({ script: "bun server.ts", rerun: "bun server.ts" });
});

test("a framework started with its own tool reloads itself", () => {
  const project = detected({ "package.json": JSON.stringify({ devDependencies: { vite: "7" } }) });
  expect(devStart(project, true)).toEqual({ script: "bunx vite", rerun: undefined });
});

test("a project with nothing to start has no command", () => {
  expect(devStart(detected({ "README.md": "# notes" }), false)).toBeUndefined();
  expect(devStart(detected({ "package.json": manifest({ test: "bun test" }) }), true)).toBeUndefined();
});

test("an argument with a space or a quote is passed as one shell word", () => {
  const project = { ...detected({}), dev: { command: "bun", args: ["my server's.ts"] } };
  expect(devStart(project, true)?.script).toBe("bun 'my server'\\''s.ts'");
});

test("a file listing is read as directory entries, one level at a time", () => {
  const files = ["package.json", "src/main.ts", "src/lib/util.ts", "srcs/other.ts"];
  expect(entriesOf(files, "")).toEqual([
    { name: "package.json", kind: "file" },
    { name: "src", kind: "directory" },
    { name: "srcs", kind: "directory" },
  ]);
  expect(entriesOf(files, "src")).toEqual([
    { name: "main.ts", kind: "file" },
    { name: "lib", kind: "directory" },
  ]);
  expect(entriesOf(files, "missing")).toEqual([]);
});

test("monorepo targets run inside a subshell in their package directory", () => {
  const { detection, targets } = detectProjectTargets({
    paths: ["package.json", "apps/web/package.json"],
    read: (path) => {
      if (path === "package.json") return JSON.stringify({ workspaces: ["apps/*"] });
      if (path === "apps/web/package.json") return JSON.stringify({ name: "web", scripts: { dev: "vite" } });
      return undefined;
    },
  });
  const [web] = targets;
  expect(web).toBeDefined();
  expect(devStart(detection, false)).toEqual({
    script: "bun install && (cd apps/web && bun run dev)",
    rerun: undefined,
  });
  expect(devStart(detection, true)).toEqual({
    script: "(cd apps/web && bun run dev)",
    rerun: undefined,
  });
  if (web) {
    expect(devStartForTarget(detection, web, true)).toEqual({
      script: "(cd apps/web && bun run dev)",
      rerun: undefined,
    });
  }
});
