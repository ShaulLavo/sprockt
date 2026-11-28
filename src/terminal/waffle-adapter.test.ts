import { describe, expect, it } from "bun:test";
import { createSignal } from "../lib/reactive";
import type { WorkspaceSession } from "../workspace/session";
import { createTerminalStore } from "./store";
import {
  createReactiveSubscribable,
  createWaffleTerminalBridge,
  normalizeTerminalLinkPath,
} from "./waffle-adapter";

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

describe("createReactiveSubscribable", () => {
  it("still notifies subscribers when a sibling listener reads getSnapshot() mid-flush", () => {
    const [state, setState] = createSignal<{ count: number; split?: string }>({ count: 1 });
    const count = createReactiveSubscribable(() => state().count);
    const split = createReactiveSubscribable(() => state().split);

    const observedSplits: Array<string | undefined> = [];
    const unsubCount = count.subscribe(() => {
      // Mirrors WorkbenchTerminalPanel reading splitId.getSnapshot() from a sessions listener
      // before splitId's own reactive effect runs inside flushEffects().
      void split.getSnapshot();
    });
    const unsubSplit = split.subscribe(() => {
      observedSplits.push(split.getSnapshot());
    });

    setState({ count: 2, split: "t2" });
    expect(observedSplits).toEqual(["t2"]);

    setState({ count: 2, split: undefined });
    expect(observedSplits).toEqual(["t2", undefined]);

    unsubCount();
    unsubSplit();
  });
});

describe("createWaffleTerminalBridge split wiring", () => {
  it("notifies activeId, splitId, and splitPair across split, focus switch, and unsplit", () => {
    const terminals = createTerminalStore();
    const t1 = terminals.create();
    const workspace = { terminals } as unknown as WorkspaceSession;
    const { adapter } = createWaffleTerminalBridge(workspace);

    const activeChanges: Array<string | undefined> = [];
    const splitChanges: Array<string | undefined> = [];
    const pairChanges: Array<readonly [string, string] | undefined> = [];

    const unsubSessions = adapter.sessions.subscribe(() => {
      // Simulate sibling snapshot reads during flush.
      void adapter.activeId.getSnapshot();
      void adapter.splitId.getSnapshot();
      void adapter.splitPair?.getSnapshot();
    });
    const unsubActive = adapter.activeId.subscribe(() => activeChanges.push(adapter.activeId.getSnapshot()));
    const unsubSplit = adapter.splitId.subscribe(() => splitChanges.push(adapter.splitId.getSnapshot()));
    const unsubPair = adapter.splitPair?.subscribe(() => pairChanges.push(adapter.splitPair?.getSnapshot()));

    adapter.toggleSplit();
    const t2 = adapter.splitId.getSnapshot();
    expect(t2).toBeDefined();
    expect(t2).not.toBe(t1);
    expect(activeChanges).toEqual([t2]);
    expect(splitChanges).toEqual([t2]);
    expect(pairChanges).toEqual([[t1, t2!]]);

    // Selecting left half keeps the split pair and moves focus to left.
    adapter.selectSession(t1);
    expect(adapter.activeId.getSnapshot()).toBe(t1);
    expect(adapter.splitPair?.getSnapshot()).toEqual([t1, t2!]);
    expect(activeChanges).toEqual([t2, t1]);
    expect(pairChanges).toEqual([[t1, t2!]]);

    // Unsplitting clears splitId and splitPair while keeping the focused left tab active.
    adapter.toggleSplit();
    expect(adapter.activeId.getSnapshot()).toBe(t1);
    expect(adapter.splitId.getSnapshot()).toBeUndefined();
    expect(adapter.splitPair?.getSnapshot()).toBeUndefined();
    expect(splitChanges).toEqual([t2, undefined]);
    expect(pairChanges).toEqual([[t1, t2!], undefined]);

    unsubSessions();
    unsubActive();
    unsubSplit();
    unsubPair?.();
  });

  it("settles waitForHandle when Ghostty renderer initialization fails before attach", async () => {
    const terminals = createTerminalStore();
    const bashId = terminals.create();
    terminals.setState(bashId, "ready");
    const devId = terminals.create({ title: "dev", named: true });
    const workspace = { terminals } as unknown as WorkspaceSession;
    const bridge = createWaffleTerminalBridge(workspace);

    const waited = terminals.waitForHandle(devId);
    bridge.reportRendererError("WebGPU adapter unavailable", new Error("WebGPU adapter unavailable"));

    expect(await waited).toEqual({
      ok: false,
      reason: "failed",
      message: "WebGPU adapter unavailable",
    });
    expect(terminals.stateOf(devId)).toBe("failed");
    expect(terminals.stateOf(bashId)).toBe("ready");
  });
});
