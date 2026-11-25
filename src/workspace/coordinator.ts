// Which tab runs a workspace's dev server. Every tab on a workspace shares its files, but each tab
// has its own process table, so exactly one tab may own the dev server. Tabs stand in line on a
// Web Lock (`sprockt:<id>:dev-server`); the holder is the owner and announces its server on a
// BroadcastChannel of the same name. When the owner tab closes or crashes the browser releases the
// lock and the next tab in line takes over: that is the failover. Ported in spirit from bun-wasm's
// `sandbox/src/dev-server-coordinator.ts`, without its reset and handover machinery.
//
// No Solid and no DOM import: panes wrap `subscribe` in a signal.

export type DevServerPhase = "starting" | "up" | "down";

/** What the owning tab says about its dev server. */
export interface DevServerState {
  /** The tab that runs the server. */
  readonly ownerTab: string;
  readonly phase: DevServerPhase;
  /** Ports the server listens on inside the owner's Waffle network, most important first. */
  readonly ports: readonly number[];
  /** The command that started it, for display (`bun run dev`). */
  readonly command?: string;
}

export type DevServerRole = "owner" | "follower";

/** Handed to the elected tab. Hold it while the server runs. */
export interface DevServerLease {
  /** Aborted when this tab stops owning the server (`release`, `dispose`). Stop the server then. */
  readonly signal: AbortSignal;
  /** Tells every tab, this one included, what the server is doing now. */
  announce(update: Omit<DevServerState, "ownerTab">): void;
  /** Gives ownership up; the next tab in line takes over. Safe to call more than once. */
  release(): void;
}

export interface DevServerCoordinator {
  readonly tabId: string;
  role(): DevServerRole;
  /** The owner's latest announcement, or `undefined` when no tab runs a server. */
  current(): DevServerState | undefined;
  /** Called on every change of `current()` or `role()`. Returns an unsubscribe function. */
  subscribe(listener: (state: DevServerState | undefined, role: DevServerRole) => void): () => void;
  /**
   * Stands in line to own the dev server. `start` runs once this tab is elected, at once when no
   * other tab owns it, or later when the owner goes away. The lock is held until the lease is
   * released, `start` throws, the returned cancel function runs, or the tab closes.
   */
  standBy(start: (lease: DevServerLease) => void | Promise<void>): () => void;
  /** Releases ownership, leaves the line and closes the channel. */
  dispose(): void;
}

type LockManagerLike = Pick<LockManager, "request">;

export interface CoordinatorOptions {
  readonly workspaceId: string;
  readonly tabId?: string;
  readonly locks?: LockManagerLike;
  readonly openChannel?: (name: string) => BroadcastChannel;
  /** How often the owner repeats its state, so a frozen or vanished owner is noticed. */
  readonly heartbeatMs?: number;
  /** A follower forgets an owner it has not heard from for this long. */
  readonly silentMs?: number;
}

type Message =
  | { readonly type: "state"; readonly state: DevServerState }
  | { readonly type: "stopped"; readonly ownerTab: string }
  | { readonly type: "hello"; readonly from: string };

export function devServerLockName(workspaceId: string): string {
  return `sprockt:${workspaceId}:dev-server`;
}

export function createDevServerCoordinator(options: CoordinatorOptions): DevServerCoordinator {
  const tabId = options.tabId ?? crypto.randomUUID();
  const locks = options.locks ?? navigator.locks;
  const name = devServerLockName(options.workspaceId);
  const channel = (options.openChannel ?? ((n) => new BroadcastChannel(n)))(name);
  const heartbeatMs = options.heartbeatMs ?? 2_000;
  const silentMs = options.silentMs ?? heartbeatMs * 3;

  const listeners = new Set<(state: DevServerState | undefined, role: DevServerRole) => void>();
  const standing = new Set<AbortController>();
  let state: DevServerState | undefined;
  let role: DevServerRole = "follower";
  let lastHeard = 0;
  let disposed = false;

  const emit = () => {
    for (const listener of listeners) listener(state, role);
  };
  const post = (message: Message) => {
    // A BroadcastChannel has no target origin: it only ever reaches this origin.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    if (!disposed) channel.postMessage(message);
  };
  const setState = (next: DevServerState | undefined) => {
    state = next;
    emit();
  };

  const onMessage = (event: MessageEvent<Message>) => {
    const message = event.data;
    if (message.type === "hello") {
      if (role === "owner" && state) post({ type: "state", state });
      return;
    }
    if (role === "owner") return;
    if (message.type === "state") {
      lastHeard = Date.now();
      setState(message.state);
      return;
    }
    if (state?.ownerTab === message.ownerTab) setState(undefined);
  };
  channel.addEventListener("message", onMessage);

  const heartbeat = setInterval(() => {
    if (role === "owner") {
      if (state) post({ type: "state", state });
      return;
    }
    if (state && Date.now() - lastHeard > silentMs) setState(undefined);
  }, heartbeatMs);

  function runAsOwner(start: (lease: DevServerLease) => void | Promise<void>, line: AbortController) {
    return new Promise<void>((resolve) => {
      const lease = new AbortController();
      const release = () => {
        if (lease.signal.aborted) return;
        lease.abort();
        line.signal.removeEventListener("abort", release);
        standing.delete(line);
        role = "follower";
        post({ type: "stopped", ownerTab: tabId });
        setState(undefined);
        resolve();
      };
      line.signal.addEventListener("abort", release, { once: true });
      role = "owner";
      emit();
      const announce = (update: Omit<DevServerState, "ownerTab">) => {
        if (lease.signal.aborted) return;
        const next: DevServerState = { ...update, ownerTab: tabId };
        post({ type: "state", state: next });
        setState(next);
      };
      Promise.resolve()
        .then(() => start({ signal: lease.signal, announce, release }))
        .catch(release);
    });
  }

  function standBy(start: (lease: DevServerLease) => void | Promise<void>): () => void {
    const line = new AbortController();
    if (disposed) return () => {};
    standing.add(line);
    locks
      .request(name, { signal: line.signal }, () => runAsOwner(start, line))
      .catch(() => standing.delete(line));
    return () => line.abort();
  }

  post({ type: "hello", from: tabId });

  return {
    tabId,
    role: () => role,
    current: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    standBy,
    dispose() {
      if (disposed) return;
      for (const line of standing) line.abort();
      disposed = true;
      clearInterval(heartbeat);
      listeners.clear();
      channel.removeEventListener("message", onMessage);
      channel.close();
    },
  };
}
