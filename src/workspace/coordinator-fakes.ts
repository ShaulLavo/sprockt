// Stand-ins for the two browser pieces the dev-server coordinator talks through, for unit tests
// of the coordinator and of what stands in its line. Several coordinators that share one
// FakeLocks and one FakeChannels behave like tabs of one browser.

interface Waiting {
  readonly mode: LockMode;
  begin(): void;
}

/**
 * A stand-in for `navigator.locks`: exclusive and shared modes, FIFO, abortable waits and
 * `ifAvailable`. `pause` holds back every grant for names that start with a prefix, as a busy
 * browser might, until `resume`.
 */
export class FakeLocks {
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
export class FakeChannels {
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
