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
  /** A command the shell runs as soon as its first prompt appears. */
  readonly run?: string;
  /** `split` opens the tab to the right of the shown one. */
  readonly placement?: "tab" | "split";
}

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
  /**
   * Stops every shell and closes every tab, for good: another tab took the workspace. Resolves
   * once the shells have stopped; later `create` calls open nothing.
   */
  shutdown(): Promise<void>;

  // Called by the tab's own view.
  /** Takes the tab's startup command, once. */
  takeCommand(id: string): string | undefined;
  attach(id: string, handle: TerminalHandle | undefined): void;
  setState(id: string, state: SessionState): void;
  setShellTitle(id: string, title: string): void;
}

export function createTerminalStore(): TerminalStore {
  const [tabs, setTabs] = createSignal<TerminalTabs>(NO_TABS);
  const [states, setStates] = createSignal<Readonly<Record<string, SessionState>>>({});
  const handles = new Map<string, TerminalHandle>();
  const commands = new Map<string, string>();
  let counter = 0;
  let stopped = false;

  function create(options: NewTerminal = {}): string {
    if (stopped) return "";
    counter += 1;
    const id = `t${counter}`;
    if (options.run) commands.set(id, options.run);
    setTabs((state) => addTab(state, id, options.title, options.placement));
    return id;
  }

  return {
    tabs,
    stateOf: (id) => states()[id] ?? "starting",
    create,
    close(id) {
      commands.delete(id);
      handles.delete(id);
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
    async shutdown() {
      stopped = true;
      const running = Array.from(handles.values(), (handle) => handle.dispose());
      handles.clear();
      commands.clear();
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
      if (handle) handles.set(id, handle);
      else handles.delete(id);
    },
    setState: (id, state) => setStates((current) => ({ ...current, [id]: state })),
    setShellTitle: (id, title) => setTabs((state) => shellTitle(state, id, title)),
  };
}
