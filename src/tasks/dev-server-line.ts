// The dev-server task's place in the workspace's line (workspace/coordinator.ts). One tab of a
// workspace runs the dev server; this decides when this tab is that one:
//
// - Asking for a server stands in the line. The tab that gets the lease starts the process and
//   announces its ports; the others see them and show the same preview address.
// - A tab that sees another tab's server stands behind it, so that it starts the server itself
//   when the owner's tab closes or crashes.
// - A server that was stopped on purpose, or ended by itself, is announced as "down" before its
//   lease ends, and the tabs behind it leave the line: nobody restarts what someone stopped.
//
// No Solid and no shell here; tasks/dev-server.ts supplies both.
import type { DevServerCoordinator, DevServerLease, DevServerState } from "../workspace/coordinator";

export type DevServerStatus = "stopped" | "starting" | "running";

/** The server's process in this tab. */
export interface ServerProcess {
  /** The command that runs, for display. */
  readonly command: string;
  /** Resolves when the process has ended, by itself or after `stop`. Never rejects. */
  readonly exited: Promise<void>;
  /** Asks the process to end. */
  stop(): void;
}

/** The ports this tab's own programs listen on. */
export interface LocalPorts {
  current(): readonly number[];
  subscribe(listener: () => void): () => void;
}

export interface LineState {
  /** The workspace's dev server, in whichever tab it runs. */
  readonly status: DevServerStatus;
  /** Whether this tab runs it. Only that tab can stop it. */
  readonly owned: boolean;
  /** Ports of a server another tab runs. Empty when this tab runs it: its ports are local. */
  readonly remotePorts: readonly number[];
}

export interface DevServerLineOptions<Command> {
  readonly coordinator: DevServerCoordinator;
  readonly ports: LocalPorts;
  /** What starts the project's server, or nothing when it has none. */
  command(): Promise<Command | undefined>;
  /**
   * Runs `command` in this tab. `signal` is the lease's: once it is aborted the server is no
   * longer wanted, and whatever is still being created has to end at once.
   */
  spawn(command: Command, signal: AbortSignal): Promise<ServerProcess>;
}

export interface DevServerLine {
  state(): LineState;
  subscribe(listener: (state: LineState) => void): () => void;
  /**
   * Wants a dev server for the workspace: starts one here unless another tab runs one. The
   * start is claimed before anything is awaited, so a second call joins the first instead of
   * starting again, and `stop` or `dispose` cancel it at whatever point it has reached.
   * Resolves false when the project has nothing to start.
   */
  start(): Promise<boolean>;
  /** Stops the server this tab runs, for every tab. Another tab's server is stopped in that tab. */
  stop(): void;
  /** Stops this tab's server without telling the others to give up, and closes the coordinator. */
  dispose(): Promise<void>;
}

const DOWN = { phase: "down", ports: [] } as const;

const aborted = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });

export function createDevServerLine<Command>(options: DevServerLineOptions<Command>): DevServerLine {
  const { coordinator, ports } = options;
  const listeners = new Set<(state: LineState) => void>();
  /** Leaves the line. Set while this tab stands in it or owns the server. */
  let leave: (() => void) | undefined;
  /** The lease, while this tab owns the server. */
  let lease: DevServerLease | undefined;
  /** `start` was called and no lease has answered it yet. */
  let requested = false;
  /** The lease whose "down" this tab already acted on. */
  let downLease: string | undefined;
  /** The start that is under way, which every `start` call until it settles shares. */
  let starting: Promise<boolean> | undefined;
  /** Moved on by `stop` and `dispose`: a start that was still looking for its command gives up. */
  let generation = 0;
  /** The command a start found, for the lease that start is about to get. */
  let found: Command | undefined;

  function state(): LineState {
    const current = coordinator.current();
    if (!current || current.phase === "down") {
      // A start this tab asked for is this tab's to stop, before it has a lease too.
      return { status: requested ? "starting" : "stopped", owned: requested, remotePorts: [] };
    }
    const owned = coordinator.role() === "owner";
    return {
      status: current.phase === "up" ? "running" : "starting",
      owned,
      remotePorts: owned ? [] : current.ports,
    };
  }

  function emit(): void {
    const current = state();
    for (const listener of listeners) listener(current);
  }

  function leaveLine(): void {
    requested = false;
    found = undefined;
    leave?.();
    leave = undefined;
  }

  /** Runs the process until it ends or the lease does, announcing its ports as they change. */
  async function serve(current: DevServerLease, process: ServerProcess): Promise<void> {
    const publish = () => {
      const listening = ports.current();
      const phase = listening.length > 0 ? "up" : "starting";
      current.announce({ phase, ports: listening, command: process.command });
    };
    publish();
    const unsubscribe = ports.subscribe(publish);
    await Promise.race([process.exited, aborted(current.signal)]);
    unsubscribe();
    // It ended by itself: every tab sees it stopped, and none takes it over.
    if (!current.signal.aborted) current.announce(DOWN);
    process.stop();
    await process.exited;
  }

  async function own(current: DevServerLease): Promise<void> {
    requested = false;
    lease = current;
    // A tab that takes the server over was never asked to start it, and looks the command up now.
    const known = found;
    found = undefined;
    try {
      const command = known ?? (await options.command());
      // Stopped or closed while the command was looked up: nothing is created at all.
      if (current.signal.aborted) return;
      // The process is this lease's from here on: `serve` stops it if the lease ended meanwhile.
      const process = command === undefined ? undefined : await options.spawn(command, current.signal);
      if (process) await serve(current, process);
      else current.announce(DOWN);
    } catch (error) {
      // A start that failed here would fail in the next tab too.
      current.announce(DOWN);
      throw error;
    } finally {
      lease = undefined;
    }
  }

  function standBy(): void {
    if (leave) return;
    const cancel = coordinator.standBy(async (current) => {
      try {
        await own(current);
      } finally {
        if (leave === cancel) leave = undefined;
      }
    });
    leave = cancel;
  }

  function follow(current: DevServerState): void {
    if (current.phase !== "down") return standBy();
    // Once per lease: a later `start` here stands in line again while that lease winds down.
    if (downLease === current.lease) return;
    downLease = current.lease;
    // A start asked for in this tab stays: it is for the next server, not the one that went down.
    if (!starting) leaveLine();
  }

  /** Ends whatever this tab has under way: a start still looking for its command, or its lease. */
  function giveUp(): void {
    generation++;
    // The start under way belongs to the generation that just ended: a later `start` begins anew.
    starting = undefined;
    leaveLine();
  }

  async function begin(): Promise<boolean> {
    if (state().status !== "stopped") return true;
    const mine = generation;
    // Claimed here, before the first await: the status is "starting" from this moment.
    requested = true;
    emit();
    let command: Command | undefined;
    try {
      command = await options.command();
    } finally {
      // Nothing to start, or the lookup failed: the claim is given back.
      if (mine === generation && command === undefined) {
        requested = false;
        emit();
      }
    }
    // Stopped or disposed while the command was looked up: nothing starts.
    if (mine !== generation) return true;
    if (command === undefined) return false;
    found = command;
    standBy();
    return true;
  }

  const unsubscribe = coordinator.subscribe((current, role) => {
    if (current && role === "follower") follow(current);
    emit();
  });

  return {
    state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      if (starting) return starting;
      const mine = begin();
      starting = mine;
      const settled = () => {
        if (starting === mine) starting = undefined;
      };
      mine.then(settled, settled);
      return mine;
    },
    stop() {
      // Said before the lease ends, so the tabs behind this one leave instead of taking over.
      lease?.announce(DOWN);
      giveUp();
      emit();
    },
    async dispose() {
      unsubscribe();
      listeners.clear();
      giveUp();
      await coordinator.dispose();
    },
  };
}
