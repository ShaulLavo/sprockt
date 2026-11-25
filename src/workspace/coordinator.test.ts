import { afterEach, expect, spyOn, test } from "bun:test";
import {
  createDevServerCoordinator,
  type CoordinatorOptions,
  type DevServerCoordinator,
  type DevServerLease,
  type DevServerRun,
} from "./coordinator";

interface Waiting {
  readonly mode: LockMode;
  begin(): void;
}

/**
 * A stand-in for `navigator.locks`: exclusive and shared modes, FIFO, abortable waits and
 * `ifAvailable`. `pause` holds back every grant for names that start with a prefix, as a busy
 * browser might, until `resume`.
 */
class FakeLocks {
  private readonly holders = new Map<string, LockMode[]>();
  private readonly queues = new Map<string, Waiting[]>();
  private paused: string | undefined;

  pause(prefix: string): void {
    this.paused = prefix;
  }

  resume(): void {
    this.paused = undefined;
    for (const name of this.queues.keys()) this.pump(name);
  }

  readonly request = ((name: string, options: LockOptions, onGranted: LockGrantedCallback<unknown>) =>
    new Promise<unknown>((resolve, reject) => {
      if (options.signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
      const mode = options.mode ?? "exclusive";
      if (options.ifAvailable && !this.available(name, mode)) {
        void Promise.resolve()
          .then(() => onGranted(null))
          .then(resolve, reject);
        return;
      }
      const waiting: Waiting = { mode, begin: () => this.grant(name, mode, onGranted, resolve, reject) };
      const onAbort = () => this.leaveQueue(name, waiting, reject);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.queue(name).push(waiting);
      this.pump(name);
    })) as LockManager["request"];

  private queue(name: string): Waiting[] {
    const queue = this.queues.get(name) ?? [];
    this.queues.set(name, queue);
    return queue;
  }

  private grant(
    name: string,
    mode: LockMode,
    onGranted: LockGrantedCallback<unknown>,
    resolve: (value: unknown) => void,
    reject: (reason: unknown) => void,
  ): void {
    const held = this.holders.get(name) ?? [];
    this.holders.set(name, held);
    held.push(mode);
    void Promise.resolve()
      .then(() => onGranted({ name, mode } as Lock))
      .then(resolve, reject)
      .finally(() => {
        held.splice(held.indexOf(mode), 1);
        this.pump(name);
      });
  }

  private leaveQueue(name: string, waiting: Waiting, reject: (reason: unknown) => void): void {
    const queue = this.queue(name);
    const index = queue.indexOf(waiting);
    if (index < 0) return;
    queue.splice(index, 1);
    reject(new DOMException("aborted", "AbortError"));
  }

  private available(name: string, mode: LockMode): boolean {
    return this.queue(name).length === 0 && this.compatible(name, mode);
  }

  private pump(name: string): void {
    if (this.paused !== undefined && name.startsWith(this.paused)) return;
    const queue = this.queue(name);
    while (queue.length > 0 && this.compatible(name, queue[0]!.mode)) queue.shift()!.begin();
  }

  private compatible(name: string, mode: LockMode): boolean {
    const held = this.holders.get(name) ?? [];
    return held.length === 0 || (mode === "shared" && held.every((other) => other === "shared"));
  }
}

interface FakeChannel {
  deliver(data: unknown): void;
}

/** Delivers between instances, never to the sender, like a real BroadcastChannel. */
class FakeChannels {
  /** Instances whose messages are dropped, by open order: a frozen or dying tab. */
  readonly muted = new Set<number>();
  /** Every message sent, for replaying one late. */
  readonly sent: unknown[] = [];
  private readonly members = new Set<FakeChannel>();
  private opened = 0;

  readonly open = (): BroadcastChannel => {
    const index = this.opened++;
    const handlers = new Set<(event: MessageEvent) => void>();
    const member: FakeChannel = {
      deliver: (data) => {
        for (const handler of handlers) handler(new MessageEvent("message", { data }));
      },
    };
    this.members.add(member);
    const channel = {
      addEventListener: (_type: string, handler: (event: MessageEvent) => void) => handlers.add(handler),
      removeEventListener: (_type: string, handler: (event: MessageEvent) => void) =>
        handlers.delete(handler),
      postMessage: (data: unknown) => this.post(index, member, data),
      close: () => this.members.delete(member),
    };
    return channel as unknown as BroadcastChannel;
  };

  /** Delivers `data` to every open member, as a message from no tab in particular. */
  replay(data: unknown): void {
    for (const member of this.members) queueMicrotask(() => member.deliver(data));
  }

  private post(index: number, sender: FakeChannel, data: unknown): void {
    if (this.muted.has(index)) return;
    this.sent.push(data);
    for (const member of this.members) {
      if (member !== sender) queueMicrotask(() => member.deliver(data));
    }
  }
}

const created: DevServerCoordinator[] = [];
afterEach(async () => {
  await Promise.all(created.splice(0).map((coordinator) => coordinator.dispose()));
});

function browser() {
  const locks = new FakeLocks();
  const channels = new FakeChannels();
  const shared: Omit<CoordinatorOptions, "tabId"> = {
    workspaceId: "demo",
    locks,
    openChannel: channels.open,
    onError: () => {},
  };
  const open = (tabId: string) => {
    const coordinator = createDevServerCoordinator({ ...shared, tabId });
    created.push(coordinator);
    return coordinator;
  };
  return { channels, locks, open };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
const aborted = (signal: AbortSignal) =>
  new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));

/** A dev server that serves `ports` until it is asked to stop. */
const serve =
  (ports: number[], leases: DevServerLease[] = []): DevServerRun =>
  async (lease) => {
    leases.push(lease);
    lease.announce({ phase: "up", ports, command: "bun run dev" });
    await aborted(lease.signal);
  };

test("the first tab in line owns the server and every tab sees its ports", async () => {
  const { open } = browser();
  const [first, second] = [open("tab-0"), open("tab-1")];
  first.standBy(serve([5173]));
  second.standBy(() => {
    throw new Error("the second tab must not start while the first owns the server");
  });
  await settle();

  expect(first.role()).toBe("owner");
  expect(second.role()).toBe("follower");
  expect(second.current()).toMatchObject({ ownerTab: "tab-0", phase: "up", ports: [5173] });
});

test("when the owner lets go the next tab in line takes over, starting with no ports", async () => {
  const { open } = browser();
  const [first, second] = [open("tab-0"), open("tab-1")];
  const leases: DevServerLease[] = [];
  first.standBy(serve([3000], leases));
  second.standBy(async (lease) => aborted(lease.signal));
  await settle();

  leases[0]!.release();
  await settle();

  expect(second.role()).toBe("owner");
  expect(first.role()).toBe("follower");
  expect(first.current()).toMatchObject({ ownerTab: "tab-1", phase: "starting", ports: [] });
});

test("the next tab does not start until the owner's server has fully stopped", async () => {
  const { open } = browser();
  const [first, second] = [open("tab-0"), open("tab-1")];
  const shutdown = Promise.withResolvers<void>();
  let secondStarted = false;
  first.standBy(async (lease) => {
    lease.announce({ phase: "up", ports: [3000] });
    await aborted(lease.signal);
    await shutdown.promise;
  });
  second.standBy(async (lease) => {
    secondStarted = true;
    await aborted(lease.signal);
  });
  const stopFirst = first.standBy(() => {});
  await settle();

  // Release, cancellation and disposal all only ask; the lock stays until shutdown ends.
  stopFirst();
  void first.dispose();
  await settle();
  expect(secondStarted).toBe(false);

  shutdown.resolve();
  await settle();
  expect(secondStarted).toBe(true);
});

test("a tab that opens later learns the running server", async () => {
  const { open } = browser();
  open("owner").standBy(serve([8080]));
  await settle();

  const late = open("late");
  await settle();
  expect(late.current()?.ports).toEqual([8080]);
});

test("a dead owner's ports reach no one: not a new tab, not a late message", async () => {
  const { open, channels } = browser();
  const owner = open("tab-0");
  const successor = open("tab-1");
  const leases: DevServerLease[] = [];
  owner.standBy(serve([3000], leases));
  await settle();
  const oldState = channels.sent.find(
    (message) => (message as { state?: { ports: number[] } }).state?.ports[0] === 3000,
  );
  expect(oldState).toBeDefined();

  // The owner's tab dies: its lock goes away and it never says "stopped".
  successor.standBy(async (lease) => aborted(lease.signal));
  channels.muted.add(0);
  leases[0]!.release();
  await settle();

  const late = open("tab-2");
  await settle();
  expect(late.current()).toMatchObject({ ownerTab: "tab-1", phase: "starting", ports: [] });

  // A delayed message from the old lease changes nothing.
  channels.replay(oldState);
  await settle();
  expect(late.current()).toMatchObject({ ownerTab: "tab-1", ports: [] });
  expect(successor.current()).toMatchObject({ ownerTab: "tab-1", ports: [] });
});

test("a silent owner that still holds its lock keeps its preview", async () => {
  const { open, channels } = browser();
  const [owner, follower] = [open("tab-0"), open("tab-1")];
  owner.standBy(serve([4000]));
  await settle();

  // A background tab whose timers the browser throttles sends nothing for a long time.
  channels.muted.add(0);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(owner.role()).toBe("owner");
  expect(follower.current()?.ports).toEqual([4000]);
});

test("a follower that is not in line notices when the owner's tab goes away", async () => {
  const { open, channels } = browser();
  const [owner, follower] = [open("tab-0"), open("tab-1")];
  const leases: DevServerLease[] = [];
  owner.standBy(serve([4000], leases));
  await settle();
  expect(follower.current()?.ports).toEqual([4000]);

  channels.muted.add(0);
  leases[0]!.release();
  await settle();
  expect(follower.current()).toBeUndefined();
});

test("a run that throws gives ownership to the next tab", async () => {
  const { open } = browser();
  const [broken, healthy] = [open("tab-0"), open("tab-1")];
  broken.standBy(() => {
    throw new Error("no package.json");
  });
  healthy.standBy(serve([1234]));
  await settle();
  expect(healthy.role()).toBe("owner");
  expect(broken.current()).toMatchObject({ ownerTab: "tab-1", ports: [1234] });
});

for (const how of ["cancelled", "disposed"] as const) {
  test(`a tab ${how} while it takes the lock starts nothing and lets the next tab in`, async () => {
    const { open, locks } = browser();
    const [first, second] = [open("tab-0"), open("tab-1")];
    let firstStarted = false;
    // The lease lock is slow to come, so the cancel arrives between the two locks.
    locks.pause("sprockt:demo:dev-server:lease:");
    const leave = first.standBy(async (lease) => {
      firstStarted = true;
      await aborted(lease.signal);
    });
    second.standBy(serve([5000]));
    await settle();

    if (how === "cancelled") leave();
    else void first.dispose();
    locks.resume();
    await settle();

    expect(firstStarted).toBe(false);
    expect(second.role()).toBe("owner");
    expect(second.current()).toMatchObject({ ownerTab: "tab-1", ports: [5000] });
  });
}

test("leases granted at the same clock reading are still told apart", async () => {
  // Firefox coarsens the clock; nothing may depend on two grants reading different times.
  const clock = spyOn(performance, "now").mockReturnValue(1000);
  try {
    const { open } = browser();
    const [first, second, follower] = [open("tab-0"), open("tab-1"), open("tab-2")];
    const leases: DevServerLease[] = [];
    first.standBy(serve([3000], leases));
    second.standBy(serve([4000]));
    await settle();
    expect(follower.current()?.ports).toEqual([3000]);

    leases[0]!.release();
    await settle();
    expect(second.role()).toBe("owner");
    expect(follower.current()).toMatchObject({ ownerTab: "tab-1", ports: [4000] });
  } finally {
    clock.mockRestore();
  }
});

test("dispose called twice waits for the same teardown", async () => {
  const { open } = browser();
  const owner = open("tab-0");
  const shutdown = Promise.withResolvers<void>();
  owner.standBy(async (lease) => {
    await aborted(lease.signal);
    await shutdown.promise;
  });
  await settle();
  let done = 0;
  void owner.dispose().then(() => done++);
  void owner.dispose().then(() => done++);
  await settle();
  expect(done).toBe(0);
  shutdown.resolve();
  await settle();
  expect(done).toBe(2);
});
