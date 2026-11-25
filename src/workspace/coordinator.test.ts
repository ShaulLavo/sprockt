import { afterEach, expect, test } from "bun:test";
import {
  createDevServerCoordinator,
  type CoordinatorOptions,
  type DevServerCoordinator,
  type DevServerLease,
} from "./coordinator";

/** An exclusive-only stand-in for `navigator.locks`: requests queue in order, a signal leaves the queue. */
function fakeLocks(): Pick<LockManager, "request"> {
  const held = new Map<string, Promise<unknown>>();
  const request = (name: string, options: LockOptions, grant: LockGrantedCallback<unknown>) => {
    const previous = held.get(name) ?? Promise.resolve();
    const signal = options.signal;
    const granted = previous.then(() => {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      return grant(null);
    });
    held.set(
      name,
      granted.catch(() => {}),
    );
    return granted;
  };
  return { request: request as LockManager["request"] };
}

interface Delivering {
  deliver(event: MessageEvent): void;
}

/** Delivers between instances, never to the sender, like a real BroadcastChannel. */
function fakeChannels(muted: Set<number> = new Set()): (name: string) => BroadcastChannel {
  const members = new Set<BroadcastChannel>();
  let opened = 0;
  return () => {
    const index = opened++;
    const handlers = new Set<(event: MessageEvent) => void>();
    const channel = {
      addEventListener: (_type: string, handler: (event: MessageEvent) => void) => handlers.add(handler),
      removeEventListener: (_type: string, handler: (event: MessageEvent) => void) =>
        handlers.delete(handler),
      deliver: (event: MessageEvent) => {
        for (const handler of handlers) handler(event);
      },
      postMessage(data: unknown) {
        if (muted.has(index)) return;
        for (const other of members) {
          if (other === channel) continue;
          queueMicrotask(() =>
            (other as unknown as Delivering).deliver(new MessageEvent("message", { data })),
          );
        }
      },
      close() {
        members.delete(channel);
      },
    } as unknown as BroadcastChannel;
    members.add(channel);
    return channel;
  };
}

const created: DevServerCoordinator[] = [];
afterEach(() => {
  for (const coordinator of created.splice(0)) coordinator.dispose();
});

function tabs(count: number, muted?: Set<number>) {
  const shared: Omit<CoordinatorOptions, "tabId"> = {
    workspaceId: "demo",
    locks: fakeLocks(),
    openChannel: fakeChannels(muted),
    heartbeatMs: 20,
  };
  return Array.from({ length: count }, (_, index) => {
    const coordinator = createDevServerCoordinator({ ...shared, tabId: `tab-${index}` });
    created.push(coordinator);
    return coordinator;
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test("the first tab in line owns the server and every tab sees its ports", async () => {
  const [first, second] = tabs(2);
  first!.standBy((lease) => lease.announce({ phase: "up", ports: [5173], command: "bun run dev" }));
  second!.standBy(() => {
    throw new Error("the second tab must not start while the first owns the server");
  });
  await settle();

  expect(first!.role()).toBe("owner");
  expect(second!.role()).toBe("follower");
  expect(second!.current()).toEqual({
    ownerTab: "tab-0",
    phase: "up",
    ports: [5173],
    command: "bun run dev",
  });
});

test("when the owner lets go the next tab in line takes over", async () => {
  const [first, second] = tabs(2);
  let firstLease: DevServerLease | undefined;
  first!.standBy((lease) => {
    firstLease = lease;
    lease.announce({ phase: "up", ports: [3000] });
  });
  second!.standBy((lease) => lease.announce({ phase: "starting", ports: [] }));
  await settle();

  firstLease!.release();
  await settle();

  expect(firstLease!.signal.aborted).toBe(true);
  expect(second!.role()).toBe("owner");
  expect(first!.role()).toBe("follower");
  expect(first!.current()).toEqual({ ownerTab: "tab-1", phase: "starting", ports: [] });
});

test("a tab that opens later learns the running server", async () => {
  const shared = { workspaceId: "late", locks: fakeLocks(), openChannel: fakeChannels(), heartbeatMs: 1_000 };
  const owner = createDevServerCoordinator({ ...shared, tabId: "owner" });
  created.push(owner);
  owner.standBy((lease) => lease.announce({ phase: "up", ports: [8080] }));
  await settle();

  const late = createDevServerCoordinator({ ...shared, tabId: "late" });
  created.push(late);
  await settle();
  expect(late.current()?.ports).toEqual([8080]);
});

test("a follower forgets an owner that went silent", async () => {
  const muted = new Set<number>();
  const [owner, follower] = tabs(2, muted);
  owner!.standBy((lease) => lease.announce({ phase: "up", ports: [4000] }));
  await settle();
  expect(follower!.current()?.ports).toEqual([4000]);

  // The owner keeps its lock but nothing it sends arrives: a frozen tab.
  muted.add(0);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(owner!.role()).toBe("owner");
  expect(follower!.current()).toBeUndefined();
});

test("a start that throws gives ownership to the next tab", async () => {
  const [broken, healthy] = tabs(2);
  broken!.standBy(() => {
    throw new Error("no package.json");
  });
  healthy!.standBy((lease) => lease.announce({ phase: "up", ports: [1234] }));
  await settle();
  expect(healthy!.role()).toBe("owner");
  expect(broken!.current()?.ownerTab).toBe("tab-1");
});
