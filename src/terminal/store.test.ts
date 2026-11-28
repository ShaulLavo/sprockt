import { describe, expect, test } from "bun:test";
import type { TerminalHandle } from "./session";
import { createTerminalStore } from "./store";

function stubHandle(): TerminalHandle {
  return {
    lines: () => [],
    size: () => ({ screen: { columns: 80, rows: 24 }, shell: { columns: 80, rows: 24 } }),
    focus: () => {},
    submit: async () => {},
    input: () => {},
    interrupt: () => {},
    isRunning: () => false,
    clear: () => {},
    getSelection: () => undefined,
    paste: () => {},
    dispose: async () => {},
  };
}

describe("createTerminalStore", () => {
  test("pins named tabs against shell OSC title updates", () => {
    const store = createTerminalStore();
    const id = store.create({ title: "dev", named: true });
    store.setShellTitle(id, "bun run dev");
    expect(store.tabs().tabs.find((tab) => tab.id === id)?.title).toBe("dev");
  });

  test("waitForHandle resolves on attach and settles on close, abort, exit, or startup failure", async () => {
    const store = createTerminalStore();
    const first = store.create({ title: "dev", named: true });
    const pending = store.waitForHandle(first);
    const handle = stubHandle();
    store.attach(first, handle);
    expect(await pending).toEqual({ ok: true, handle });

    // Exiting clears the handle so a subsequent wait reports exited instead of returning a dead handle.
    store.setState(first, "exited");
    expect(store.handle(first)).toBeUndefined();
    expect(await store.waitForHandle(first)).toEqual({ ok: false, reason: "exited" });

    const second = store.create();
    const closing = store.waitForHandle(second);
    store.close(second);
    expect(await closing).toEqual({ ok: false, reason: "closed" });

    const third = store.create();
    const controller = new AbortController();
    const aborted = store.waitForHandle(third, controller.signal);
    controller.abort();
    expect(await aborted).toEqual({ ok: false, reason: "aborted" });

    const fourth = store.create({ title: "dev", named: true });
    const failing = store.waitForHandle(fourth);
    store.setState(fourth, "failed", "Shell WASM failed");
    expect(await failing).toEqual({ ok: false, reason: "failed", message: "Shell WASM failed" });
    expect(await store.waitForHandle(fourth)).toEqual({
      ok: false,
      reason: "failed",
      message: "Shell WASM failed",
    });
  });

  test("delivers output taps and reveal requests to subscribers", () => {
    const store = createTerminalStore();
    const id = store.create({ title: "dev", named: true });
    const chunks: string[] = [];
    const decoder = new TextDecoder();
    const stopOut = store.subscribeOutput(id, (bytes) => chunks.push(decoder.decode(bytes)));
    store.emitOutput(id, new TextEncoder().encode("ready on :3000"));
    stopOut();
    store.emitOutput(id, new TextEncoder().encode("ignored"));
    expect(chunks).toEqual(["ready on :3000"]);

    let reveals = 0;
    const stopReveal = store.onRevealRequest(() => {
      reveals += 1;
    });
    store.requestReveal();
    stopReveal();
    store.requestReveal();
    expect(reveals).toBe(1);
  });
});
