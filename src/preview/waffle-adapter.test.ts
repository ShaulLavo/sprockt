import { describe, expect, it } from "bun:test";
import type { PreviewFrameEvent } from "@shaulavo/workbench/core";
import type { FrameCommand, FrameMessage } from "./bridge";
import type { PreviewServer, PreviewTransport } from "./transport";
import { createWafflePreviewAdapter } from "./waffle-adapter";

function createFakeTransport(options?: { readonly takesCommands?: boolean }) {
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  let currentServers: readonly PreviewServer[] = [];
  const serverListeners = new Set<(servers: readonly PreviewServer[]) => void>();
  let messageListener: ((message: FrameMessage) => void) | undefined;
  let reloadListener: (() => void) | undefined;

  const transport: PreviewTransport = {
    kind: "mounted",
    takesCommands: options?.takesCommands ?? true,
    serverEnv: {},
    whenReady: () => ready,
    register: () => {},
    unregister: () => {},
    servers: () => currentServers,
    subscribe(listener) {
      serverListeners.add(listener);
      return () => serverListeners.delete(listener);
    },
    frameUrl: (port, path) => `https://sprockt.test/__preview/ws1/${port}${path}`,
    tabUrl: (port, path) => `https://sprockt.test/__preview/ws1/${port}${path}`,
    locate(href) {
      const match = /^https:\/\/sprockt\.test\/__preview\/ws1\/(\d+)(\/.*)$/.exec(href);
      if (!match?.[1] || !match[2]) return undefined;
      return { port: Number(match[1]), path: match[2] };
    },
    watch(_frame, listener) {
      messageListener = listener;
      return () => {
        if (messageListener === listener) messageListener = undefined;
      };
    },
    onReloadNeeded(listener) {
      reloadListener = listener;
      return () => {
        if (reloadListener === listener) reloadListener = undefined;
      };
    },
    dispose: async () => {},
  };

  return {
    transport,
    resolveReady,
    setServers(next: readonly PreviewServer[]) {
      currentServers = next;
      for (const listener of serverListeners) listener(next);
    },
    emitMessage: (message: FrameMessage) => messageListener?.(message),
    emitReloadNeeded: () => reloadListener?.(),
  };
}

describe("createWafflePreviewAdapter", () => {
  it("gates server emission until whenReady resolves and merges remote ports sorted", async () => {
    const fake = createFakeTransport();
    const adapter = createWafflePreviewAdapter(fake.transport);
    const changes: number[] = [];
    const unsub = adapter.servers.subscribe(() => changes.push(adapter.servers.getSnapshot().length));

    fake.setServers([{ port: 5173, label: "vite" }]);
    adapter.setRemotePorts([3000]);
    expect(adapter.servers.getSnapshot()).toEqual([]);

    fake.resolveReady();
    await adapter.whenReady();
    expect(adapter.servers.getSnapshot()).toEqual([{ port: 3000 }, { port: 5173, label: "vite" }]);
    expect(changes).toEqual([2]);

    unsub();
    adapter.dispose();
  });

  it("handles bridged hello handshake, navigation, errors, and bridgeless fragment-stripping reload", async () => {
    const fake = createFakeTransport({ takesCommands: true });
    fake.resolveReady();
    const adapter = createWafflePreviewAdapter(fake.transport);
    await adapter.whenReady();

    const posted: Array<{ message: FrameCommand; origin: string }> = [];
    const fakeFrame = {
      src: "https://sprockt.test/__preview/ws1/3000/",
      contentWindow: {
        postMessage(message: FrameCommand, origin: string) {
          posted.push({ message, origin });
        },
      },
    } as unknown as HTMLIFrameElement;

    const events: PreviewFrameEvent[] = [];
    const controller = adapter.attachFrame(fakeFrame, 3000, (event) => events.push(event));

    // Before handshake acknowledgement, reload strips fragments and reloads via frame.src.
    controller.navigate("/about#team");
    expect(fakeFrame.src).toBe("https://sprockt.test/__preview/ws1/3000/about#team");
    controller.reload();
    expect(fakeFrame.src).toBe("https://sprockt.test/__preview/ws1/3000/about");
    expect(events.at(-1)).toEqual({
      type: "navigate",
      location: { port: 3000, path: "/about" },
      replace: true,
    });

    // onFrameLoad sends hello; matching hello ack marks bridged and routes navigate/reload via postMessage.
    controller.onFrameLoad();
    expect(posted).toEqual([
      { message: { source: "sprockt-preview", command: "hello", id: 1 }, origin: "https://sprockt.test" },
    ]);
    fake.emitMessage({ source: "sprockt-preview", type: "hello", id: 1 });
    expect(events.at(-1)).toEqual({ type: "bridge-ready", supported: true });

    controller.navigate("/../5174/about");
    expect(posted.at(-1)).toEqual({
      message: {
        source: "sprockt-preview",
        command: "navigate",
        href: "https://sprockt.test/__preview/ws1/3000/5174/about",
      },
      origin: "https://sprockt.test",
    });

    controller.reload();
    expect(posted.at(-1)).toEqual({
      message: { source: "sprockt-preview", command: "reload" },
      origin: "https://sprockt.test",
    });

    fake.emitMessage({ source: "sprockt-preview", type: "error", message: "kaboom" });
    expect(events.at(-1)).toEqual({ type: "error", message: "kaboom" });

    controller.dispose();
    adapter.dispose();
  });
});
