import { afterEach, describe, expect, test } from "bun:test";
import type { WorkspaceSession } from "../workspace/session";
import { attachAfterImport, configureAfterImport, onAfterImport, type WithLock } from "./after-import";
import {
  parseMeta,
  serializeMeta,
  WORKSPACE_META_PATH,
  type ImportPlan,
  type WorkspaceMeta,
} from "./metadata";

const PLAN: ImportPlan = { install: { command: "bun", args: ["install"] }, dev: undefined, port: undefined };

/** Workspace files holding only metadata, with or without a pending plan. */
function metadata(pending?: ImportPlan): Map<string, string> {
  const meta: WorkspaceMeta = { name: "demo", created: "", ...(pending ? { pendingImport: pending } : {}) };
  return new Map([[WORKSPACE_META_PATH, serializeMeta(meta)]]);
}

const pendingIn = (files: Map<string, string>) => parseMeta(files.get(WORKSPACE_META_PATH))?.pendingImport;

/**
 * A session over shared in-memory files, as every tab on one workspace sees them. The metadata
 * is reached through the raw filesystem, at its path on the filesystem root.
 */
function fakeSession(id: string, files: Map<string, string>, failWrite = false) {
  return {
    id,
    runtime: {
      filesystem: {
        readFile: async (path: string) => {
          const value = files.get(path);
          return value === undefined ? undefined : new TextEncoder().encode(value);
        },
        writeFile: async (path: string, value: string | Uint8Array) => {
          if (failWrite) throw new Error("write failed");
          files.set(path, String(value));
        },
        mkdirp: async () => undefined,
        flush: async () => {},
      },
    },
  } as unknown as WorkspaceSession;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function noop(): void {}
const noLock: WithLock = (_name, task) => task();

describe("after-import hook", () => {
  const stops: (() => void)[] = [];
  afterEach(() => {
    for (const stop of stops.splice(0)) stop();
    configureAfterImport({});
  });

  test("a handler registered after the workbench opened still receives the plan, once", async () => {
    configureAfterImport({ withLock: noLock });
    const files = metadata(PLAN);
    stops.push(attachAfterImport(fakeSession("ws1", files)));
    await settle();
    expect(pendingIn(files)).toEqual(PLAN);

    const seen: string[] = [];
    stops.push(onAfterImport((opened, plan) => void seen.push(`${opened.id}:${plan.install?.command}`)));
    await settle();
    expect(seen).toEqual(["ws1:bun"]);
    expect(pendingIn(files)).toBeUndefined();

    // A reload (a new session on the same files) finds nothing left to run.
    stops.push(attachAfterImport(fakeSession("ws1", files)));
    await settle();
    expect(seen).toEqual(["ws1:bun"]);
  });

  test("the plan is handed to the handler before it is removed from the workspace", async () => {
    configureAfterImport({ withLock: noLock });
    const files = metadata(PLAN);
    const stillPending: unknown[] = [];
    stops.push(onAfterImport(() => void stillPending.push(pendingIn(files))));
    stops.push(attachAfterImport(fakeSession("ws2", files)));
    await settle();
    expect(stillPending).toEqual([PLAN]);
    expect(pendingIn(files)).toBeUndefined();
  });

  test("a session that detaches while waiting for the lock leaves the plan for later", async () => {
    let detach: () => void = noop;
    // The tab leaves while another tab holds the lock; the claim then runs.
    configureAfterImport({
      withLock: async (_name, task) => {
        await Promise.resolve();
        detach();
        return task();
      },
    });
    const files = metadata(PLAN);
    const seen: string[] = [];
    stops.push(onAfterImport(() => void seen.push("ran")));
    detach = attachAfterImport(fakeSession("ws3", files));
    await settle();
    expect(seen).toEqual([]);
    expect(pendingIn(files)).toEqual(PLAN);

    // The next session on this workspace (another tab, or after a reload) takes it.
    configureAfterImport({ withLock: noLock });
    stops.push(attachAfterImport(fakeSession("ws3", files)));
    await settle();
    expect(seen).toEqual(["ran"]);
    expect(pendingIn(files)).toBeUndefined();
  });

  test("tabs wait for the lock in turn: the second finds nothing once the first took the plan", async () => {
    let queue = Promise.resolve();
    const waitingLock: WithLock = (_name, task) => {
      const result = queue.then(task);
      queue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    };
    configureAfterImport({ withLock: waitingLock });
    const files = metadata(PLAN);
    const seen: string[] = [];
    stops.push(onAfterImport((session) => void seen.push(session.id)));
    stops.push(attachAfterImport(fakeSession("tab-a", files)));
    stops.push(attachAfterImport(fakeSession("tab-b", files)));
    await settle();
    await settle();
    expect(seen).toEqual(["tab-a"]);
  });

  test("a failed removal is reported and leaves the plan", async () => {
    const reported: unknown[] = [];
    configureAfterImport({ withLock: noLock, reportError: (error) => reported.push(error) });
    const files = metadata(PLAN);
    stops.push(onAfterImport(() => undefined));
    stops.push(attachAfterImport(fakeSession("ws4", files, true)));
    await settle();
    expect(reported.map((error) => (error as Error).message)).toEqual(["write failed"]);
    expect(pendingIn(files)).toEqual(PLAN);
  });

  test("a failing handler is reported, not thrown, and the others still run", async () => {
    const reported: unknown[] = [];
    configureAfterImport({ withLock: noLock, reportError: (error) => reported.push(error) });
    const seen: string[] = [];
    stops.push(
      onAfterImport(() => {
        throw new Error("install failed");
      }),
    );
    stops.push(onAfterImport(() => void seen.push("second")));
    stops.push(attachAfterImport(fakeSession("ws5", metadata(PLAN))));
    await settle();
    expect(seen).toEqual(["second"]);
    expect(reported.map((error) => (error as Error).message)).toEqual(["install failed"]);
  });

  test("a workspace without a pending plan runs nothing", async () => {
    configureAfterImport({ withLock: noLock });
    const seen: string[] = [];
    stops.push(onAfterImport(() => void seen.push("ran")));
    stops.push(attachAfterImport(fakeSession("ws6", metadata())));
    await settle();
    expect(seen).toEqual([]);
  });
});
