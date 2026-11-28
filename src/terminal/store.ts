// The workspace's terminal tabs. The store holds the tab list and each shell's state; every tab's
// view starts its own Ghostty + bash-web session on the shared runtime and reports its handle
// here, so other parts of the workbench (a dev-server task, an install step) can open a tab
// and run a command in it without reaching into the terminal pane.
import { createSignal, type Accessor } from "../lib/reactive";
import type { SessionState, TerminalHandle } from "./session";
import {
  addTab,
  closeTab,
  cycleTab,
  NO_TABS,
  renameTab,
  selectTab,
  shellTitle,
  unsplit,
  type TerminalTabs,
} from "./tabs";

export interface NewTerminal {
  /** The tab's name; defaults to "bash", "bash 2" and so on. */
  readonly title?: string;
  /** Keep `title` pinned instead of letting OSC shell title sequences replace it. */
  readonly named?: boolean;
  /** A command the shell runs as soon as its first prompt appears. */
  readonly run?: string;
  /** `split` opens the tab to the right of the shown one. */
  readonly placement?: "tab" | "split";
}

export type TerminalWaitResult =
  | { readonly ok: true; readonly handle: TerminalHandle }
  | {
      readonly ok: false;
      readonly reason: "closed" | "aborted" | "exited" | "failed";
      readonly message?: string;
    };

export interface TerminalStore {
  readonly tabs: Accessor<TerminalTabs>;
  /** The shell state of one tab; `starting` until its view reports otherwise. */
  stateOf(id: string): SessionState;
  /** Opens a tab and returns its id. */
  create(options?: NewTerminal): string;
  /** Closes a tab; its view stops the shell. */
  close(id: string): void;
  rename(id: string, title: string): void;
  select(id: string): void;
  cycle(direction: 1 | -1): void;
  /** Splits the panel with a new shell, or ends the split if there is one. */
  toggleSplit(): void;
  /** The live handle of a tab whose shell has started. */
  handle(id: string): TerminalHandle | undefined;
  /** Resolves once `id` attaches a live handle, or reports why startup ended (`closed`, `aborted`, `exited`, `failed`). */
  waitForHandle(id: string, signal?: AbortSignal): Promise<TerminalWaitResult>;
  /** Taps raw output bytes written by one terminal session. Returns the unsubscribe function. */
  subscribeOutput(id: string, listener: (bytes: Uint8Array) => void): () => void;
  /** Asks the workbench to expand/unhide the terminal panel (e.g. when a dev server starts). */
  requestReveal(): void;
  /** Subscribes to reveal requests from tasks such as the dev server. */
  onRevealRequest(listener: () => void): () => void;
  /**
   * Stops every shell and closes every tab, for good: another tab took the workspace. Resolves
   * once the shells have stopped; later `create` calls open nothing.
   */
  shutdown(): Promise<void>;

  // Called by the tab's own view.
  /** Takes the tab's startup command, once. */
  takeCommand(id: string): string | undefined;
  attach(id: string, handle: TerminalHandle | undefined): void;
  emitOutput(id: string, bytes: Uint8Array): void;
  setState(id: string, state: SessionState, detail?: string): void;
  setShellTitle(id: string, title: string): void;
}

export function createTerminalStore(): TerminalStore {
  const [tabs, setTabs] = createSignal<TerminalTabs>(NO_TABS);
  const [states, setStates] = createSignal<Readonly<Record<string, SessionState>>>({});
  const handles = new Map<string, TerminalHandle>();
  const failureMessages = new Map<string, string>();
  const commands = new Map<string, string>();
  const handleWaiters = new Map<string, Set<(result: TerminalWaitResult) => void>>();
  const outputListeners = new Map<string, Set<(bytes: Uint8Array) => void>>();
  const revealListeners = new Set<() => void>();
  let revealPending = false;
  let counter = 0;
  let stopped = false;

  function resolveWaiters(id: string, result: TerminalWaitResult): void {
    const waiters = handleWaiters.get(id);
    if (!waiters) return;
    handleWaiters.delete(id);
    for (const resolve of waiters) resolve(result);
  }

  function create(options: NewTerminal = {}): string {
    if (stopped) return "";
    counter += 1;
    const id = `t${counter}`;
    if (options.run) commands.set(id, options.run);
    setTabs((state) => addTab(state, id, options.title, options.placement, options.named));
    return id;
  }

  return {
    tabs,
    stateOf: (id) => states()[id] ?? "starting",
    create,
    close(id) {
      commands.delete(id);
      handles.delete(id);
      failureMessages.delete(id);
      resolveWaiters(id, { ok: false, reason: "closed" });
      outputListeners.delete(id);
      setTabs((state) => closeTab(state, id));
      setStates(({ [id]: _closed, ...rest }) => rest);
    },
    rename: (id, title) => setTabs((state) => renameTab(state, id, title)),
    select: (id) => setTabs((state) => selectTab(state, id)),
    cycle: (direction) => setTabs((state) => cycleTab(state, direction)),
    toggleSplit() {
      if (tabs().split) setTabs(unsplit);
      else create({ placement: "split" });
    },
    handle: (id) => handles.get(id),
    waitForHandle(id, signal) {
      const currentState = states()[id] ?? "starting";
      const existing = handles.get(id);
      if (existing && currentState !== "exited" && currentState !== "failed") {
        return Promise.resolve({ ok: true, handle: existing });
      }
      if (signal?.aborted) return Promise.resolve({ ok: false, reason: "aborted" });
      if (stopped || !tabs().tabs.some((tab) => tab.id === id)) {
        return Promise.resolve({ ok: false, reason: "closed" });
      }
      if (currentState === "failed") {
        return Promise.resolve({ ok: false, reason: "failed", message: failureMessages.get(id) });
      }
      if (currentState === "exited") {
        return Promise.resolve({ ok: false, reason: "exited" });
      }
      return new Promise<TerminalWaitResult>((resolve) => {
        const finish = (result: TerminalWaitResult): void => {
          signal?.removeEventListener("abort", onAbort);
          const set = handleWaiters.get(id);
          set?.delete(finish);
          if (set && set.size === 0) handleWaiters.delete(id);
          resolve(result);
        };
        const onAbort = (): void => finish({ ok: false, reason: "aborted" });
        let set = handleWaiters.get(id);
        if (!set) {
          set = new Set();
          handleWaiters.set(id, set);
        }
        set.add(finish);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
    subscribeOutput(id, listener) {
      let set = outputListeners.get(id);
      if (!set) {
        set = new Set();
        outputListeners.set(id, set);
      }
      set.add(listener);
      return () => {
        const current = outputListeners.get(id);
        current?.delete(listener);
        if (current && current.size === 0) outputListeners.delete(id);
      };
    },
    requestReveal() {
      revealPending = revealListeners.size === 0;
      for (const listener of Array.from(revealListeners)) listener();
    },
    onRevealRequest(listener) {
      revealListeners.add(listener);
      if (revealPending) {
        revealPending = false;
        listener();
      }
      return () => revealListeners.delete(listener);
    },
    async shutdown() {
      stopped = true;
      const running = Array.from(handles.values(), (handle) => handle.dispose());
      for (const id of Array.from(handleWaiters.keys())) {
        resolveWaiters(id, { ok: false, reason: "closed" });
      }
      handles.clear();
      failureMessages.clear();
      commands.clear();
      outputListeners.clear();
      // Unmounting the views aborts shells that are still starting and frees their screens.
      setTabs(NO_TABS);
      setStates({});
      await Promise.allSettled(running);
    },
    takeCommand(id) {
      const command = commands.get(id);
      commands.delete(id);
      return command;
    },
    attach(id, handle) {
      if (handle) {
        handles.set(id, handle);
        resolveWaiters(id, { ok: true, handle });
      } else {
        handles.delete(id);
      }
    },
    emitOutput(id, bytes) {
      const listeners = outputListeners.get(id);
      if (!listeners) return;
      for (const listener of Array.from(listeners)) listener(bytes);
    },
    setState(id, state, detail) {
      if (state === "failed") {
        if (detail) failureMessages.set(id, detail);
        handles.delete(id);
        setStates((current) => ({ ...current, [id]: state }));
        resolveWaiters(id, { ok: false, reason: "failed", message: detail });
        return;
      }
      if (state === "exited") {
        handles.delete(id);
        setStates((current) => ({ ...current, [id]: state }));
        resolveWaiters(id, { ok: false, reason: "exited" });
        return;
      }
      setStates((current) => ({ ...current, [id]: state }));
    },
    setShellTitle: (id, title) => setTabs((state) => shellTitle(state, id, title)),
  };
}
