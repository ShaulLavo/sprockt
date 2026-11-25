import { afterEach, expect, test } from "bun:test";
import { createDevServerCoordinator } from "../workspace/coordinator";
import { FakeChannels, FakeLocks } from "../workspace/coordinator-fakes";
import { createDevServerLine, type DevServerLine, type ServerProcess } from "./dev-server-line";

interface FakeProcess extends ServerProcess {
  stops: number;
  /** The process ends by itself, as a crashed or finished server does. */
  end(): void;
}

function fakeProcess(command: string): FakeProcess {
  const exited = Promise.withResolvers<void>();
  const process: FakeProcess = {
    command,
    exited: exited.promise,
    stops: 0,
    stop() {
      process.stops++;
      exited.resolve();
    },
    end: () => exited.resolve(),
  };
  return process;
}

const lines: DevServerLine[] = [];
afterEach(async () => {
  await Promise.all(lines.splice(0).map((line) => line.dispose()));
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

/** One browser: tabs opened from it share its locks and its channel. */
function browser() {
  const locks = new FakeLocks();
  const channels = new FakeChannels();
  return function openTab(tabId: string) {
    const coordinator = createDevServerCoordinator({
      workspaceId: "demo",
      tabId,
      locks,
      openChannel: channels.open,
      onError: () => {},
    });
    const processes: FakeProcess[] = [];
    const portListeners = new Set<() => void>();
    let listening: readonly number[] = [];
    const tab = {
      /** What the project starts with, or nothing when it has no dev script. */
      command: "bun run dev" as string | undefined,
      /** Held back launches resolve when this does. */
      ready: Promise.resolve(),
      processes,
      listen(ports: readonly number[]) {
        listening = ports;
        for (const listener of portListeners) listener();
      },
      line: createDevServerLine({
        coordinator,
        ports: {
          current: () => listening,
          subscribe(listener) {
            portListeners.add(listener);
            return () => portListeners.delete(listener);
          },
        },
        async launch() {
          await tab.ready;
          if (!tab.command) return undefined;
          const process = fakeProcess(tab.command);
          processes.push(process);
          return process;
        },
      }),
    };
    lines.push(tab.line);
    return tab;
  };
}

test("the tab that asks runs the server, and the status follows its ports", async () => {
  const first = browser()("tab-0");
  expect(first.line.state().status).toBe("stopped");

  first.line.start();
  expect(first.line.state().status).toBe("starting");
  await settle();
  expect(first.processes).toHaveLength(1);
  expect(first.line.state()).toEqual({ status: "starting", owned: true, remotePorts: [] });

  first.listen([5173]);
  expect(first.line.state()).toEqual({ status: "running", owned: true, remotePorts: [] });
  first.listen([]);
  expect(first.line.state().status).toBe("starting");
});

test("another tab sees the owner's ports and starts no second server", async () => {
  const openTab = browser();
  const [first, second] = [openTab("tab-0"), openTab("tab-1")];
  first.line.start();
  await settle();
  first.listen([5173]);
  await settle();

  expect(second.line.state()).toEqual({ status: "running", owned: false, remotePorts: [5173] });
  second.line.start();
  await settle();
  expect(second.processes).toHaveLength(0);
  expect(first.processes).toHaveLength(1);
});

test("a tab opened after the server started sees it too", async () => {
  const openTab = browser();
  const first = openTab("tab-0");
  first.line.start();
  await settle();
  first.listen([5173]);
  await settle();

  const late = openTab("tab-1");
  await settle();
  expect(late.line.state()).toEqual({ status: "running", owned: false, remotePorts: [5173] });
});

test("when the owner's tab goes away, a tab behind it starts the server", async () => {
  const openTab = browser();
  const [first, second] = [openTab("tab-0"), openTab("tab-1")];
  first.line.start();
  await settle();
  first.listen([5173]);
  await settle();

  // Closing a tab ends its lease without a word, as a crash would.
  await first.line.dispose();
  await settle();
  expect(first.processes[0]?.stops).toBe(1);
  expect(second.processes).toHaveLength(1);
  expect(second.line.state().owned).toBe(true);
});

test("a server stopped on purpose is not restarted by another tab", async () => {
  const openTab = browser();
  const [first, second] = [openTab("tab-0"), openTab("tab-1")];
  first.line.start();
  await settle();
  first.listen([5173]);
  await settle();

  first.line.stop();
  await settle();
  expect(first.processes[0]?.stops).toBe(1);
  expect(second.processes).toHaveLength(0);
  expect(first.line.state().status).toBe("stopped");
  expect(second.line.state()).toEqual({ status: "stopped", owned: false, remotePorts: [] });

  // Either tab can start it again afterwards.
  second.line.start();
  await settle();
  expect(second.processes).toHaveLength(1);
  expect(first.line.state().status).toBe("starting");
});

test("a server that ends by itself is not taken over", async () => {
  const openTab = browser();
  const [first, second] = [openTab("tab-0"), openTab("tab-1")];
  first.line.start();
  await settle();
  first.listen([5173]);
  await settle();

  first.processes[0]?.end();
  await settle();
  expect(second.processes).toHaveLength(0);
  expect(first.line.state().status).toBe("stopped");
  expect(second.line.state().status).toBe("stopped");
});

test("a project with nothing to start leaves every tab stopped", async () => {
  const openTab = browser();
  const [first, second] = [openTab("tab-0"), openTab("tab-1")];
  first.command = undefined;
  first.line.start();
  await settle();
  expect(first.processes).toHaveLength(0);
  expect(first.line.state().status).toBe("stopped");
  expect(second.processes).toHaveLength(0);
  expect(second.line.state().status).toBe("stopped");
});

test("a stop while the server is still being started stops it, and no tab takes over", async () => {
  const openTab = browser();
  const [first, second] = [openTab("tab-0"), openTab("tab-1")];
  const ready = Promise.withResolvers<void>();
  first.ready = ready.promise;
  first.line.start();
  await settle();
  expect(second.line.state().status).toBe("starting");

  first.line.stop();
  ready.resolve();
  await settle();
  expect(first.processes[0]?.stops).toBe(1);
  expect(second.processes).toHaveLength(0);
  expect(second.line.state().status).toBe("stopped");
});

test("starting again right after a stop runs a new server once the old one has ended", async () => {
  const first = browser()("tab-0");
  first.line.start();
  await settle();
  first.line.stop();
  first.line.start();
  expect(first.line.state().status).toBe("starting");
  await settle();
  expect(first.processes).toHaveLength(2);
  expect(first.processes[0]?.stops).toBe(1);
  expect(first.processes[1]?.stops).toBe(0);
  expect(first.line.state().owned).toBe(true);
});
