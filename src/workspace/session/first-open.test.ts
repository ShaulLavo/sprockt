import { expect, test } from "bun:test";
import { withWorkspaceMetaLock } from "../hint";
import {
  INCOMPLETE,
  readMetaFile,
  serializeMeta,
  type ImportPlan,
  type MetaFilesystem,
  type WorkspaceMeta,
} from "../metadata";
import { runFirstOpenPlan } from "./first-open";

const PLAN: ImportPlan = {
  install: { command: "bun", args: ["install"] },
  dev: { command: "bun", args: ["run", "dev"] },
  port: 5173,
};

function workspace(id: string, extra: Partial<WorkspaceMeta> = {}) {
  let text = serializeMeta({ name: "demo", created: "", pendingImport: PLAN, ...extra });
  const filesystem: MetaFilesystem = {
    readFile: async () => new TextEncoder().encode(text),
    writeFile: async (_path, value) => {
      text = String(value);
    },
    mkdirp: async () => {},
    flush: async () => {},
  };
  return { id, filesystem, signal: new AbortController().signal };
}

test("two sessions opening the same workspace hand over the plan once", async () => {
  const opened = workspace("two-sessions");
  const seen: ImportPlan[] = [];
  const run = (plan: ImportPlan) => seen.push(plan);

  await Promise.all([runFirstOpenPlan(opened, run), runFirstOpenPlan({ ...opened }, run)]);
  await runFirstOpenPlan(opened, run);
  expect(seen).toEqual([PLAN]);
  expect(await readMetaFile(opened.filesystem)).toEqual({ name: "demo", created: "" });
});

test("closing while waiting for metadata leaves the plan for the next session", async () => {
  const opened = workspace("cancelled-session");
  const gate = Promise.withResolvers<void>();
  const lock = withWorkspaceMetaLock(opened.id, () => gate.promise);
  const controller = new AbortController();
  const seen: ImportPlan[] = [];
  const run = (plan: ImportPlan) => seen.push(plan);

  const closing = runFirstOpenPlan({ ...opened, signal: controller.signal }, run);
  controller.abort();
  gate.resolve();
  await expect(closing).rejects.toHaveProperty("name", "AbortError");
  await lock;
  expect(seen).toEqual([]);

  await runFirstOpenPlan(opened, run);
  expect(seen).toEqual([PLAN]);
});

test("an incomplete workspace keeps its plan until the files are ready", async () => {
  const opened = workspace("incomplete", { state: INCOMPLETE });
  const seen: ImportPlan[] = [];
  await runFirstOpenPlan(opened, (plan) => seen.push(plan));

  expect(seen).toEqual([]);
  expect((await readMetaFile(opened.filesystem))?.pendingImport).toEqual(PLAN);
});

test("a failed metadata write is reported and leaves the plan", async () => {
  const opened = workspace("write-failed");
  const failed = {
    ...opened,
    filesystem: {
      ...opened.filesystem,
      writeFile: async () => {
        throw new Error("write failed");
      },
    },
  };
  await expect(runFirstOpenPlan(failed, () => {})).rejects.toThrow("write failed");
  expect((await readMetaFile(opened.filesystem))?.pendingImport).toEqual(PLAN);
});
