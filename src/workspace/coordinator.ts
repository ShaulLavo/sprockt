// Which tab runs a workspace's dev server. Every tab on a workspace shares its files, but each tab
// has its own process table, so exactly one tab may run the dev server.
//
// - Tabs stand in line on a Web Lock (`sprockt:<id>:dev-server`). The holder owns the server, and
//   keeps the lock until its server has fully stopped, so two servers never run at once.
// - Each ownership is a lease with an epoch (when it was granted). The owner announces the lease's
//   state on a BroadcastChannel of the same name; a new lease starts with no ports. Peers ignore
//   states from a lease older than the newest one they know has ended or is running.
// - Liveness is a second lock that the owner holds for exactly its lease. Peers wait on it in
//   shared mode: when they get it, the owner is gone, whether it said so or its tab closed or
//   crashed. Messages carry state only, never liveness, so a background tab whose timers the
//   browser throttles keeps its preview.
//
// Ported in spirit from bun-wasm's `sandbox/src/dev-server-coordinator.ts`, without its reset and
// handover machinery. No Solid and no DOM import: panes wrap `subscribe` in a signal.

export type DevServerPhase = "starting" | "up" | "down";

/** What the owning tab says about its dev server. */
export interface DevServerState {
  /** The tab that runs the server. */
  readonly ownerTab: string;
  /** The ownership this state belongs to. A tab that takes over starts a new lease. */
  readonly lease: string;
  /** When the lease was granted; a later lease has a larger epoch. */
  readonly epoch: number;
  readonly phase: DevServerPhase;
  /** Ports the server listens on inside the owner's Waffle network, most important first. */
  readonly ports: readonly number[];
  /** The command that started it, for display (`bun run dev`). */
  readonly command?: string;
}

export type DevServerUpdate = Pick<DevServerState, "phase" | "ports" | "command">;

export type DevServerRole = "owner" | "follower";

/** Handed to the elected tab while it owns the server. */
export interface DevServerLease {
  /** Aborted when this tab should stop its server: `release`, cancelled line or `dispose`. */
  readonly signal: AbortSignal;
  /** Tells every tab, this one included, what the server is doing now. */
  announce(update: DevServerUpdate): void;
  /** Asks this tab to stop its server; the next tab takes over once `run` has settled. */
  release(): void;
}

/**
 * Runs the dev server for as long as this tab owns it. Its promise settling means the server has
 * stopped: start the server, wait for `lease.signal` to abort, stop the server, then resolve.
 * The lock is held until then, so the next tab never starts a second server early.
 */
export type DevServerRun = (lease: DevServerLease) => void | Promise<void>;

export interface DevServerCoordinator {
  readonly tabId: string;
  role(): DevServerRole;
  /** The current owner's latest state, or `undefined` when no tab runs a server. */
  current(): DevServerState | undefined;
  /** Called on every change of `current()` or `role()`. Returns an unsubscribe function. */
  subscribe(listener: (state: DevServerState | undefined, role: DevServerRole) => void): () => void;
  /**
   * Stands in line to own the dev server. `run` starts at once when no other tab owns it, or
   * later when the owner goes away. The returned function leaves the line, or stops this tab's
   * server if it owns it.
   */
  standBy(run: DevServerRun): () => void;
  /** Leaves the line, stops this tab's server, and resolves once its lock is released. */
  dispose(): Promise<void>;
}

type LockManagerLike = Pick<LockManager, "request">;

export interface CoordinatorOptions {
  readonly workspaceId: string;
  readonly tabId?: string;
  readonly locks?: LockManagerLike;
  readonly openChannel?: (name: string) => BroadcastChannel;
  /** Reports a `run` that failed. */
  readonly onError?: (error: unknown) => void;
}

type Message =
  | { readonly type: "state"; readonly state: DevServerState }
  | { readonly type: "stopped"; readonly lease: string; readonly epoch: number }
  | { readonly type: "hello" };

export function devServerLockName(workspaceId: string): string {
  return `sprockt:${workspaceId}:dev-server`;
}

const leaseLockName = (workspaceId: string, lease: string) =>
  `${devServerLockName(workspaceId)}:lease:${lease}`;

/** Wall-clock milliseconds with sub-millisecond precision, comparable across this origin's tabs. */
const now = () => performance.timeOrigin + performance.now();

const isAbort = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

/** Whether `next` is a later lease than `current`. */
function isLater(next: DevServerState, current: DevServerState): boolean {
  if (next.epoch !== current.epoch) return next.epoch > current.epoch;
  return next.lease > current.lease;
}

export function createDevServerCoordinator(options: CoordinatorOptions): DevServerCoordinator {
  const tabId = options.tabId ?? crypto.randomUUID();
  const locks = options.locks ?? navigator.locks;
  const name = devServerLockName(options.workspaceId);
  const channel = (options.openChannel ?? ((n) => new BroadcastChannel(n)))(name);
  const onError = options.onError ?? ((error) => console.error("The dev server stopped", error));

  const listeners = new Set<(state: DevServerState | undefined, role: DevServerRole) => void>();
  const lines = new Set<AbortController>();
  const owning = new Set<Promise<void>>();
  let state: DevServerState | undefined;
  let role: DevServerRole = "follower";
  let ownLease: string | undefined;
  /** Every lease with an epoch up to this one has ended. */
  let floor = 0;
  let leases = 0;
  let ownerWatch: AbortController | undefined;
  let disposed = false;

  const emit = () => {
    for (const listener of listeners) listener(state, role);
  };
  const post = (message: Message) => {
    // A BroadcastChannel has no target origin: it only ever reaches this origin.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    channel.postMessage(message);
  };

  /** A lease has ended: forget it and everything older. */
  function ended(lease: string, epoch: number): void {
    floor = Math.max(floor, epoch);
    if (state?.lease !== lease) return;
    state = undefined;
    emit();
  }

  /** Learns when another tab's lease ends, however its tab went away. */
  function watchOwner(owner: DevServerState): void {
    ownerWatch?.abort();
    const watch = new AbortController();
    ownerWatch = watch;
    locks
      .request(
        leaseLockName(options.workspaceId, owner.lease),
        { mode: "shared", signal: watch.signal },
        () => ended(owner.lease, owner.epoch),
      )
      .catch((error: unknown) => {
        if (!isAbort(error)) onError(error);
      });
  }

  function adopt(next: DevServerState): void {
    if (next.epoch <= floor || ownLease !== undefined) return;
    if (state && state.lease !== next.lease && !isLater(next, state)) return;
    if (state?.lease !== next.lease) watchOwner(next);
    state = next;
    emit();
  }

  const onMessage = (event: MessageEvent<Message>) => {
    const message = event.data;
    if (message.type === "hello") {
      if (ownLease !== undefined && state) post({ type: "state", state });
      return;
    }
    if (message.type === "state") adopt(message.state);
    else ended(message.lease, message.epoch);
  };
  channel.addEventListener("message", onMessage);

  /** Takes the lease's own lock; resolves with its release once it is held. */
  async function holdLease(lease: string): Promise<() => void> {
    const held = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    void locks.request(leaseLockName(options.workspaceId, lease), { mode: "exclusive" }, () => {
      held.resolve();
      return released.promise;
    });
    await held.promise;
    return released.resolve;
  }

  /** Runs inside the main lock: the lock is released when this settles. */
  async function own(run: DevServerRun, line: AbortController): Promise<void> {
    const lease = `${tabId}:${++leases}`;
    const epoch = now();
    const releaseLease = await holdLease(lease);
    const stop = new AbortController();
    const onLineAbort = () => stop.abort();
    line.signal.addEventListener("abort", onLineAbort, { once: true });
    ownerWatch?.abort();
    ownLease = lease;
    role = "owner";
    const announce = (update: DevServerUpdate) => {
      if (stop.signal.aborted) return;
      state = { ...update, ownerTab: tabId, lease, epoch };
      post({ type: "state", state });
      emit();
    };
    // A new owner starts from nothing: no port of the previous owner may outlive it.
    announce({ phase: "starting", ports: [] });
    try {
      await run({ signal: stop.signal, announce, release: () => stop.abort() });
    } catch (error) {
      onError(error);
    } finally {
      stop.abort();
      line.signal.removeEventListener("abort", onLineAbort);
      lines.delete(line);
      ownLease = undefined;
      role = "follower";
      post({ type: "stopped", lease, epoch });
      releaseLease();
      ended(lease, epoch);
      emit();
    }
  }

  function standBy(run: DevServerRun): () => void {
    if (disposed) return () => {};
    const line = new AbortController();
    lines.add(line);
    const owned = locks
      .request(name, { signal: line.signal }, () => own(run, line))
      .catch((error: unknown) => {
        lines.delete(line);
        if (!isAbort(error)) onError(error);
      });
    owning.add(owned);
    void owned.finally(() => owning.delete(owned));
    return () => line.abort();
  }

  post({ type: "hello" });

  return {
    tabId,
    role: () => role,
    current: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    standBy,
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const line of lines) line.abort();
      await Promise.all(owning);
      ownerWatch?.abort();
      listeners.clear();
      channel.removeEventListener("message", onMessage);
      channel.close();
    },
  };
}
