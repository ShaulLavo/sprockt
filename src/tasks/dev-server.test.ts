import { afterEach, describe, expect, test } from "bun:test";
import type { Runtime } from "waffle";
import type { FileService } from "../files/service";
import type { PreviewTransport } from "../preview/transport";
import type { TerminalHandle } from "../terminal/session";
import { createTerminalStore } from "../terminal/store";
import { FakeChannels, FakeLocks } from "../workspace/coordinator-fakes";
import { createDevServer, type DevServer } from "./dev-server";

const servers: DevServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.dispose()));
});

function fakeHost(
  filesMap: Readonly<Record<string, string>>,
  shared?: { id: string; tabId: string; locks: FakeLocks; channels: FakeChannels },
) {
  const terminals = createTerminalStore();
  const encoder = new TextEncoder();
  const files = {
    list: async () => Object.keys(filesMap),
    readBytes: async (path: string) => (path in filesMap ? encoder.encode(filesMap[path]) : undefined),
    subscribe: () => () => {},
    subscribeEdits: () => () => {},
  } as unknown as FileService;
  const runtime = {
    filesystem: {
      resolvePath: async (path: string) =>
        path.endsWith("/node_modules") && "node_modules/.keep" in filesMap
          ? { kind: "directory" }
          : undefined,
    },
  } as unknown as Runtime;
  const portListeners = new Set<() => void>();
  let openPorts: readonly number[] = [];
  const preview = {
    servers: () => openPorts.map((port) => ({ port })),
    subscribe: (listener: () => void) => {
      portListeners.add(listener);
      return () => portListeners.delete(listener);
    },
  } as unknown as PreviewTransport;
  const locks = shared?.locks ?? new FakeLocks();
  const channels = shared?.channels ?? new FakeChannels();
  return {
    id: shared?.id ?? `test-${crypto.randomUUID()}`,
    runtime,
    shell: {
      wasmUrl: new URL("http://localhost/shell.wasm"),
      workerUrl: new URL("http://localhost/shell.worker.js"),
      cwd: "/workspace",
      env: {},
    },
    files,
    preview,
    terminals,
    coordinator: {
      tabId: shared?.tabId,
      locks,
      openChannel: channels.open,
    },
    listen(ports: readonly number[]) {
      openPorts = ports;
      for (const listener of portListeners) listener();
    },
  };
}

function makeFakeHandle(onSubmit: (cmd: string) => Promise<void>): TerminalHandle & { running: boolean } {
  const handle: TerminalHandle & { running: boolean } = {
    running: false,
    lines: () => [],
    size: () => ({ screen: { columns: 80, rows: 24 }, shell: { columns: 80, rows: 24 } }),
    focus: () => {},
    async submit(cmd) {
      handle.running = true;
      try {
        await onSubmit(cmd);
      } finally {
        handle.running = false;
      }
    },
    input: () => {},
    interrupt: () => {},
    isRunning: () => handle.running,
    clear: () => {},
    getSelection: () => undefined,
    paste: () => {},
    dispose: async () => {},
  };
  return handle;
}

const tick = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

describe("createDevServer terminal lifecycle", () => {
  test("releases lease, reports error, and marks ended when initial dev terminal startup fails", async () => {
    const host = fakeHost({
      "server.ts": "Bun.serve({ port: 3000, fetch: () => new Response('ok') })",
    });
    const server = createDevServer(host);
    servers.push(server);

    const started = await server.start();
    expect(started).toBe(true);
    await tick();

    const devTab = host.terminals.tabs().tabs.find((tab) => tab.title === "dev");
    expect(devTab).toBeDefined();
    if (!devTab) return;

    // Simulate BrowserSession.create failing before any handle attaches.
    host.terminals.setState(devTab.id, "failed", "Shell WASM fetch failed");
    await tick(30);

    expect(server.status()).toBe("stopped");
    expect(server.ended()).toBe(true);
    expect(server.output()).toContain("Shell WASM fetch failed");
  });

  test("anchors submitted commands to host.shell.cwd and replaces an exited dev terminal on retry", async () => {
    const host = fakeHost({
      "server.ts": "Bun.serve({ port: 3000, fetch: () => new Response('ok') })",
    });
    const server = createDevServer(host);
    servers.push(server);

    const submitted: string[] = [];
    const firstFinish = Promise.withResolvers<void>();
    const secondFinish = Promise.withResolvers<void>();

    await server.start();
    await tick();
    const firstTab = host.terminals.tabs().tabs.find((tab) => tab.title === "dev");
    expect(firstTab).toBeDefined();
    if (!firstTab) return;

    host.terminals.attach(
      firstTab.id,
      makeFakeHandle(async (cmd) => {
        submitted.push(cmd);
        await firstFinish.promise;
      }),
    );
    await tick();
    expect(submitted).toEqual(["(cd /workspace && bun server.ts)"]);

    // Stop server, then user types `exit` inside that dev tab.
    server.stop();
    firstFinish.resolve();
    await tick(20);
    host.terminals.setState(firstTab.id, "exited");
    await tick();

    // Starting again must create a fresh dev terminal rather than reusing the exited one.
    await server.start();
    await tick();
    const devTabs = host.terminals.tabs().tabs.filter((tab) => tab.title === "dev");
    expect(devTabs.length).toBe(2);
    const secondTab = devTabs[1];
    expect(secondTab?.id).not.toBe(firstTab.id);
    if (!secondTab) return;

    host.terminals.attach(
      secondTab.id,
      makeFakeHandle(async (cmd) => {
        submitted.push(cmd);
        await secondFinish.promise;
      }),
    );
    await tick();
    expect(submitted).toEqual(["(cd /workspace && bun server.ts)", "(cd /workspace && bun server.ts)"]);
    server.stop();
    secondFinish.resolve();
  });

  test("preserves the selected monorepo target when another tab takes over the lease", async () => {
    const files = {
      "package.json": JSON.stringify({ name: "mono", workspaces: ["apps/*"] }),
      "node_modules/.keep": "",
      "apps/web/package.json": JSON.stringify({
        name: "web",
        scripts: { dev: "vite" },
        devDependencies: { vite: "^6.0.0" },
      }),
      "apps/api/package.json": JSON.stringify({
        name: "api",
        scripts: { dev: "bun server.ts" },
      }),
    };
    const workspaceId = `mono-${crypto.randomUUID()}`;
    const locks = new FakeLocks();
    const channels = new FakeChannels();
    const firstHost = fakeHost(files, { id: workspaceId, tabId: "tab-1", locks, channels });
    const secondHost = fakeHost(files, { id: workspaceId, tabId: "tab-2", locks, channels });

    const first = createDevServer(firstHost);
    const second = createDevServer(secondHost);
    servers.push(first, second);
    await tick();

    // Default target is apps/web:dev (Vite), while tab 1 explicitly chooses apps/api:dev.
    expect(first.defaultTargetId()).toBe("apps/web:dev");
    expect(second.defaultTargetId()).toBe("apps/web:dev");
    first.selectTarget("apps/api:dev");

    const submittedFirst: string[] = [];
    const submittedSecond: string[] = [];
    const firstFinish = Promise.withResolvers<void>();
    const secondFinish = Promise.withResolvers<void>();

    await first.start();
    await tick();
    const firstTab = firstHost.terminals.tabs().tabs.find((tab) => tab.title === "dev");
    expect(firstTab).toBeDefined();
    if (!firstTab) return;
    firstHost.terminals.attach(
      firstTab.id,
      makeFakeHandle(async (cmd) => {
        submittedFirst.push(cmd);
        await firstFinish.promise;
      }),
    );
    firstHost.listen([3102]);
    await tick(25);

    expect(submittedFirst).toEqual(["(cd /workspace && (cd apps/api && bun run dev))"]);
    expect(second.remoteTargetId()).toBe("apps/api:dev");
    expect(second.remotePorts()).toEqual([3102]);

    // Closing tab 1 hands the lease to tab 2, which must restart apps/api:dev, not apps/web:dev.
    firstFinish.resolve();
    await first.dispose();
    await tick(25);

    const secondTab = secondHost.terminals.tabs().tabs.find((tab) => tab.title === "dev");
    expect(secondTab).toBeDefined();
    if (!secondTab) return;
    secondHost.terminals.attach(
      secondTab.id,
      makeFakeHandle(async (cmd) => {
        submittedSecond.push(cmd);
        await secondFinish.promise;
      }),
    );
    await tick(25);

    expect(second.owned()).toBe(true);
    expect(second.selectedTargetId()).toBe("apps/api:dev");
    expect(submittedSecond).toEqual(["(cd /workspace && (cd apps/api && bun run dev))"]);
    second.stop();
    secondFinish.resolve();
  });
});
