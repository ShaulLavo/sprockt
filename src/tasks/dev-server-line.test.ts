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

interface FakeTab {
  /** What the project starts with, or nothing when it has no dev script. */
  command: string | undefined;
  /** Looking the command up takes until this resolves. */
  looking: Promise<void>;
  /** How often the command was looked up. */
  lookups: number;
  /** How often a process was asked for, whether or not it came to exist. */
  spawns: number;
  /** Creating the process takes until this resolves. */
  ready: Promise<void>;
  readonly processes: FakeProcess[];
  listen(ports: readonly number[]): void;
  readonly line: DevServerLine;
}

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
    const tab: FakeTab = {
      command: "bun run dev",
      looking: Promise.resolve(),
      lookups: 0,
      spawns: 0,
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
        async command() {
          tab.lookups++;
          await tab.looking;
          return tab.command;
        },
        async spawn(command, signal) {
          tab.spawns++;
          await tab.ready;
          const process = fakeProcess(command);
          processes.push(process);
          // As the real one does: a server nobody wants any more ends as soon as it exists.
          if (signal.aborted) process.stop();
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

  void first.line.start();
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
  void first.line.start();
  await settle();
  first.listen([5173]);
  await settle();

  expect(second.line.state()).toEqual({ status: "running", owned: false, remotePorts: [5173] });
  void second.line.start();
  await settle();
  expect(second.processes).toHaveLength(0);
  expect(first.processes).toHaveLength(1);
});

test("a tab opened after the server started sees it too", async () => {
  const openTab = browser();
  const first = openTab("tab-0");
  void first.line.start();
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
  void first.line.start();
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
  void first.line.start();
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
  void second.line.start();
  await settle();
  expect(second.processes).toHaveLength(1);
  expect(first.line.state().status).toBe("starting");
});

test("a server that ends by itself is not taken over", async () => {
  const openTab = browser();
  const [first, second] = [openTab("tab-0"), openTab("tab-1")];
  void first.line.start();
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
  expect(await first.line.start()).toBe(false);
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
  void first.line.start();
  await settle();
  expect(second.line.state().status).toBe("starting");

  first.line.stop();
  ready.resolve();
  await settle();
  expect(first.processes[0]?.stops).toBeGreaterThanOrEqual(1);
  expect(second.processes).toHaveLength(0);
  expect(second.line.state().status).toBe("stopped");
});

test("starting again right after a stop runs a new server once the old one has ended", async () => {
  const first = browser()("tab-0");
  void first.line.start();
  await settle();
  first.line.stop();
  void first.line.start();
  expect(first.line.state().status).toBe("starting");
  await settle();
  expect(first.processes).toHaveLength(2);
  expect(first.processes[0]?.stops).toBe(1);
  expect(first.processes[1]?.stops).toBe(0);
  expect(first.line.state().owned).toBe(true);
});

test("two starts at the same moment are one start: one lookup, one server", async () => {
  const first = browser()("tab-0");
  const looking = Promise.withResolvers<void>();
  first.looking = looking.promise;
  const [one, two] = [first.line.start(), first.line.start()];
  // The start is claimed before the command is known: the status says so, and it is this tab's.
  expect(first.line.state()).toEqual({ status: "starting", owned: true, remotePorts: [] });
  const three = first.line.start();
  looking.resolve();
  expect(await Promise.all([one, two, three])).toEqual([true, true, true]);
  await settle();
  expect(first.lookups).toBe(1);
  expect(first.processes).toHaveLength(1);
});

test("a stop while the command is still being looked up starts nothing", async () => {
  const openTab = browser();
  const [first, second] = [openTab("tab-0"), openTab("tab-1")];
  const looking = Promise.withResolvers<void>();
  first.looking = looking.promise;
  const started = first.line.start();
  first.line.stop();
  expect(first.line.state().status).toBe("stopped");
  looking.resolve();
  await started;
  await settle();
  expect(first.processes).toHaveLength(0);
  expect(second.processes).toHaveLength(0);
  expect(first.line.state()).toEqual({ status: "stopped", owned: false, remotePorts: [] });
});

test("closing the tab while the command is looked up, or the process is created, leaves nothing running", async () => {
  const openTab = browser();
  const [looker, creator] = [openTab("tab-0"), openTab("tab-1")];
  const looking = Promise.withResolvers<void>();
  looker.looking = looking.promise;
  void looker.line.start();
  const closed = looker.line.dispose();
  looking.resolve();
  await closed;
  await settle();
  expect(looker.processes).toHaveLength(0);

  const ready = Promise.withResolvers<void>();
  creator.ready = ready.promise;
  void creator.line.start();
  await settle();
  const closing = creator.line.dispose();
  ready.resolve();
  // Disposal waits for the process that was being created, and stops it.
  await closing;
  expect(creator.processes).toHaveLength(1);
  expect(creator.processes[0]?.stops).toBeGreaterThanOrEqual(1);
});

test("a lookup that fails gives the claim back, and the next start tries again", async () => {
  const first = browser()("tab-0");
  first.looking = Promise.reject(new Error("the project could not be read"));
  await expect(first.line.start()).rejects.toThrow("the project could not be read");
  await settle();
  expect(first.line.state().status).toBe("stopped");

  first.looking = Promise.resolve();
  expect(await first.line.start()).toBe(true);
  await settle();
  expect(first.processes).toHaveLength(1);
});

test("a tab stopped while it looks the command up for a takeover never creates a process", async () => {
  const openTab = browser();
  const [first, second] = [openTab("tab-0"), openTab("tab-1")];
  void first.line.start();
  await settle();
  first.listen([5173]);
  await settle();

  // The owner's tab goes away, and the tab behind it takes the lease and looks the command up.
  const looking = Promise.withResolvers<void>();
  second.looking = looking.promise;
  await first.line.dispose();
  await settle();
  expect(second.lookups).toBe(1);

  second.line.stop();
  looking.resolve();
  await settle();
  // Not "created and then stopped": it was never asked for.
  expect(second.spawns).toBe(0);
  expect(second.processes).toHaveLength(0);
  expect(second.line.state()).toEqual({ status: "stopped", owned: false, remotePorts: [] });
});

test("start, stop, start while the first lookup is still under way: the second start wins", async () => {
  const first = browser()("tab-0");
  const looking = Promise.withResolvers<void>();
  first.looking = looking.promise;
  const one = first.line.start();
  first.line.stop();
  const two = first.line.start();
  // The second start is its own start, not the cancelled one handed back.
  expect(two).not.toBe(one);
  expect(first.line.state()).toEqual({ status: "starting", owned: true, remotePorts: [] });

  looking.resolve();
  expect(await Promise.all([one, two])).toEqual([true, true]);
  await settle();
  expect(first.processes).toHaveLength(1);
  expect(first.processes[0]?.stops).toBe(0);
  expect(first.line.state().owned).toBe(true);
});

test("stop, start, stop in a row leaves nothing running, whatever each had reached", async () => {
  const openTab = browser();
  const [first, second] = [openTab("tab-0"), openTab("tab-1")];
  const looking = Promise.withResolvers<void>();
  first.looking = looking.promise;
  void first.line.start();
  first.line.stop();
  void first.line.start();
  first.line.stop();
  looking.resolve();
  await settle();
  expect(first.spawns).toBe(0);
  expect(first.line.state().status).toBe("stopped");
  expect(second.processes).toHaveLength(0);
});

test("a process still being created when its lease ends is told so, and ends", async () => {
  const first = browser()("tab-0");
  const ready = Promise.withResolvers<void>();
  first.ready = ready.promise;
  void first.line.start();
  await settle();
  expect(first.spawns).toBe(1);
  first.line.stop();
  ready.resolve();
  await settle();
  expect(first.processes).toHaveLength(1);
  // Ended by the lease's signal when it came to exist, and asked once more by the line: both harmless.
  expect(first.processes[0]?.stops).toBeGreaterThanOrEqual(1);
  expect(first.line.state().status).toBe("stopped");
});
