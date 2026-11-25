import { expect, test } from "bun:test";
import { detectProject } from "../importer/detect/detect";
import { devCommand, entriesOf } from "./detect";

function detected(files: Record<string, string>) {
  return detectProject({ paths: Object.keys(files), read: (path) => files[path] });
}

const manifest = (scripts: Record<string, string>) => JSON.stringify({ name: "app", scripts });

test("a project with a dev script runs it, installing first only when nothing is installed", () => {
  const project = detected({ "package.json": manifest({ dev: "vite" }) });
  expect(devCommand(project, false)).toBe("bun install && bun run dev");
  expect(devCommand(project, true)).toBe("bun run dev");
});

test("a server file without package.json is run directly, with nothing to install", () => {
  const project = detected({ "server.ts": "Bun.serve({ port: 3000, fetch: () => new Response('ok') });" });
  expect(devCommand(project, false)).toBe("bun --hot server.ts");
});

test("a project with nothing to start has no command", () => {
  expect(devCommand(detected({ "README.md": "# notes" }), false)).toBeUndefined();
  expect(devCommand(detected({ "package.json": manifest({ test: "bun test" }) }), true)).toBeUndefined();
});

test("an argument with a space or a quote is passed as one shell word", () => {
  const project = { ...detected({}), dev: { command: "bun", args: ["--hot", "my server's.ts"] } };
  expect(devCommand(project, true)).toBe("bun --hot 'my server'\\''s.ts'");
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
