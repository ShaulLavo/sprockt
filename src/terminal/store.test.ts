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

  test("waitForHandle resolves on attach and returns undefined on close or abort", async () => {
    const store = createTerminalStore();
    const first = store.create({ title: "dev", named: true });
    const pending = store.waitForHandle(first);
    const handle = stubHandle();
    store.attach(first, handle);
    expect(await pending).toBe(handle);

    const second = store.create();
    const closing = store.waitForHandle(second);
    store.close(second);
    expect(await closing).toBeUndefined();

    const third = store.create();
    const controller = new AbortController();
    const aborted = store.waitForHandle(third, controller.signal);
    controller.abort();
    expect(await aborted).toBeUndefined();
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
