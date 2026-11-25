// Which tab runs a workspace's dev server. Every tab on a workspace shares its files, but each tab
// has its own process table, so exactly one tab may run the dev server.
//
// - Tabs stand in line on a Web Lock (`sprockt:<id>:dev-server`). The holder owns the server, and
//   keeps the lock until its server has fully stopped, so two servers never run at once.
// - Each ownership is a lease with its own lock, which the owner holds for exactly as long as the
//   lease lasts; only one lease lock is ever held at a time. The owner announces the lease's state
//   on a BroadcastChannel of the same name, and a new lease starts with no ports.
// - Peers trust locks, not clocks or timers. A state from a lease they don't follow yet is taken
//   only if that lease's lock is held right now (it is then the live owner, and the one before it
//   has ended); otherwise it is a late message from a lease that is gone. Peers then wait on the
//   lease lock in shared mode: when they get it, the owner is gone, whether it said so or its tab
//   closed or crashed. A background tab whose timers the browser throttles keeps its preview.
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
  | { readonly type: "stopped"; readonly lease: string }
  | { readonly type: "hello" };

export function devServerLockName(workspaceId: string): string {
  return `sprockt:${workspaceId}:dev-server`;
}

const leaseLockName = (workspaceId: string, lease: string) =>
  `${devServerLockName(workspaceId)}:lease:${lease}`;

const isAbort = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

export function createDevServerCoordinator(options: CoordinatorOptions): DevServerCoordinator {
  const tabId = options.tabId ?? crypto.randomUUID();
  const locks = options.locks ?? navigator.locks;
  const name = devServerLockName(options.workspaceId);
  const channel = (options.openChannel ?? ((n) => new BroadcastChannel(n)))(name);
  const onError = options.onError ?? ((error) => console.error("The dev server stopped", error));

  const listeners = new Set<(state: DevServerState | undefined, role: DevServerRole) => void>();
  const lines = new Set<AbortController>();
  const owning = new Set<Promise<void>>();
  /** Leases known to be over. Small: one entry per ownership change this tab has seen. */
  const endedLeases = new Set<string>();
  /** The latest state of each lease whose lock is being checked. */
  const checking = new Map<string, DevServerState>();
  let state: DevServerState | undefined;
  let role: DevServerRole = "follower";
  let ownLease: string | undefined;
  let leases = 0;
  let ownerWatch: AbortController | undefined;
  let disposal: Promise<void> | undefined;

  const emit = () => {
    for (const listener of listeners) listener(state, role);
  };
  const post = (message: Message) => {
    // A BroadcastChannel has no target origin: it only ever reaches this origin.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    channel.postMessage(message);
  };
  const leaseLock = (lease: string) => leaseLockName(options.workspaceId, lease);

  function ended(lease: string): void {
    endedLeases.add(lease);
    checking.delete(lease);
    if (state?.lease !== lease) return;
    state = undefined;
    emit();
  }

  /** Learns when another tab's lease ends, however its tab went away. */
  function watchOwner(lease: string): void {
    ownerWatch?.abort();
    const watch = new AbortController();
    ownerWatch = watch;
    locks
      .request(leaseLock(lease), { mode: "shared", signal: watch.signal }, () => ended(lease))
      .catch((error: unknown) => {
        if (!isAbort(error)) onError(error);
      });
  }

  /** Whether the lease's lock is held right now, which only its live owner does. */
  function isLive(lease: string): Promise<boolean> {
    return locks.request(leaseLock(lease), { mode: "shared", ifAvailable: true }, (lock) => lock === null);
  }

  /** A lease proved live: it is the owner now, and whatever this tab followed before is over. */
  function follow(next: DevServerState): void {
    if (state && state.lease !== next.lease) endedLeases.add(state.lease);
    state = next;
    watchOwner(next.lease);
    emit();
  }

  async function check(lease: string): Promise<void> {
    const live = await isLive(lease).catch(() => false);
    const next = checking.get(lease);
    checking.delete(lease);
    if (!next || endedLeases.has(lease) || ownLease !== undefined) return;
    if (live) follow(next);
    else ended(lease);
  }

  function adopt(next: DevServerState): void {
    if (ownLease !== undefined || endedLeases.has(next.lease)) return;
    if (state?.lease === next.lease) {
      state = next;
      emit();
      return;
    }
    const pending = checking.has(next.lease);
    checking.set(next.lease, next);
    if (!pending) void check(next.lease);
  }

  const onMessage = (event: MessageEvent<Message>) => {
    const message = event.data;
    if (message.type === "hello") {
      if (ownLease !== undefined && state) post({ type: "state", state });
      return;
    }
    if (message.type === "state") adopt(message.state);
    else ended(message.lease);
  };
  channel.addEventListener("message", onMessage);

  /**
   * Takes the lease's own lock. Resolves with its release once held, or with nothing when the
   * line was cancelled first.
   */
  function holdLease(lease: string, signal: AbortSignal): Promise<(() => void) | undefined> {
    const held = Promise.withResolvers<(() => void) | undefined>();
    const released = Promise.withResolvers<void>();
    locks
      .request(leaseLock(lease), { mode: "exclusive", signal }, () => {
        held.resolve(released.resolve);
        return released.promise;
      })
      .catch(() => held.resolve(undefined));
    return held.promise;
  }

  /** Runs inside the main lock: the lock is released when this settles. */
  async function own(run: DevServerRun, line: AbortController): Promise<void> {
    // A line cancelled while it waited gives the lock straight back and starts nothing.
    if (line.signal.aborted) return;
    const lease = `${tabId}:${++leases}`;
    const releaseLease = await holdLease(lease, line.signal);
    if (!releaseLease) return;
    if (line.signal.aborted) return releaseLease();
    const stop = new AbortController();
    const onLineAbort = () => stop.abort();
    line.signal.addEventListener("abort", onLineAbort, { once: true });
    ownerWatch?.abort();
    checking.clear();
    ownLease = lease;
    role = "owner";
    const announce = (update: DevServerUpdate) => {
      if (stop.signal.aborted) return;
      state = { ...update, ownerTab: tabId, lease };
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
      ownLease = undefined;
      role = "follower";
      post({ type: "stopped", lease });
      releaseLease();
      ended(lease);
      emit();
    }
  }

  function standBy(run: DevServerRun): () => void {
    if (disposal) return () => {};
    const line = new AbortController();
    lines.add(line);
    const owned = locks
      .request(name, { signal: line.signal }, () => own(run, line))
      .catch((error: unknown) => {
        if (!isAbort(error)) onError(error);
      })
      .finally(() => lines.delete(line));
    owning.add(owned);
    void owned.finally(() => owning.delete(owned));
    return () => line.abort();
  }

  async function tearDown(): Promise<void> {
    for (const line of lines) line.abort();
    await Promise.all(owning);
    ownerWatch?.abort();
    listeners.clear();
    channel.removeEventListener("message", onMessage);
    channel.close();
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
    dispose: () => (disposal ??= tearDown()),
  };
}
