// Places in the workbench frame that other slices fill without importing the frame: status bar
// items (the branch, the dev server, the cursor position) and commands the title bar offers a
// button for (quick open, share, download, the workspace switcher). Both live on the
// WorkspaceSession as plain data.
import { createSignal, type Accessor } from "solid-js";
import type { IconName } from "../ui/icons";

export type StatusTone = "neutral" | "ok" | "warn" | "danger";

/** A secondary control on a status item, such as the dev server's stop button. */
export interface StatusAction {
  readonly label: string;
  readonly icon: IconName;
  run(): void;
}

export interface StatusItem {
  readonly text: string;
  /** Tooltip and accessible description. */
  readonly title?: string;
  readonly tone?: StatusTone;
  readonly icon?: IconName;
  /** `start` is the left end of the bar, `end` the right. Defaults to `start`. */
  readonly side?: "start" | "end";
  /** Lower numbers sit further left. Defaults to 0. */
  readonly order?: number;
  readonly onClick?: () => void;
  readonly action?: StatusAction;
}

/** Well-known status item ids, so two slices never fill the same place twice. */
export const STATUS_SLOT = {
  /** Git branch (a later slice). Shown in the title bar under the workspace name and in the status bar. */
  branch: "branch",
  /**
   * The dev server (slice 5). Shown as the title bar pill, not in the status bar: `text` is the
   * port (":5173"), `tone: "ok"` while it runs, and `action` is the stop button.
   */
  devServer: "dev-server",
  /** Cursor position and language of the open file (slice 3). */
  cursor: "cursor",
  language: "language",
} as const;

export interface StatusEntry extends StatusItem {
  readonly id: string;
}

export interface StatusItems {
  /** Every item, sorted by side and order. */
  readonly items: Accessor<readonly StatusEntry[]>;
  get(id: string): StatusItem | undefined;
  /** Sets or, with `undefined`, removes an item. */
  set(id: string, item: StatusItem | undefined): void;
}

export function sortStatus(entries: readonly StatusEntry[]): StatusEntry[] {
  const rank = (entry: StatusEntry) => (entry.side === "end" ? 1 : 0);
  return entries.toSorted((a, b) => rank(a) - rank(b) || (a.order ?? 0) - (b.order ?? 0));
}

/** A map held in a signal, replaced on every change so readers update. */
function createSignalMap<Value>() {
  const [map, setMap] = createSignal<ReadonlyMap<string, Value>>(new Map());
  const update = (id: string, value: Value | undefined) =>
    setMap((current) => {
      const next = new Map(current);
      if (value === undefined) next.delete(id);
      else next.set(id, value);
      return next;
    });
  return { map, update };
}

export function createStatusItems(): StatusItems {
  const { map, update } = createSignalMap<StatusItem>();
  return {
    items: () => sortStatus(Array.from(map(), ([id, item]) => ({ ...item, id }))),
    get: (id) => map().get(id),
    set: update,
  };
}

/** Commands the frame offers a button for. Each button shows only once a slice registers it. */
export const COMMAND = {
  /** Open a file by name (slice 3's Cmd+P): the title bar search field and the phone search icon. */
  quickOpen: "quick-open",
  /** Share link for the workspace (slice 4). */
  share: "share",
  /** Download the workspace as a ZIP (slice 2). */
  download: "download",
  /** Switch to another workspace (slice 1): the workspace name becomes a menu button. */
  switchWorkspace: "switch-workspace",
} as const;

export interface Command {
  /** The button's label, in the registering slice's copy. */
  readonly label: string;
  readonly icon?: IconName;
  /** The keyboard shortcut as shown to the user, such as "⌘P". */
  readonly shortcut?: string;
  /** A count that puts a dot on the phone menu and a badge on the item. */
  readonly badge?: Accessor<number>;
  run(): void;
}

export interface Commands {
  /** Registers a command; the returned function unregisters it. */
  register(id: string, command: Command): () => void;
  get(id: string): Command | undefined;
  run(id: string): void;
}

export function createCommands(): Commands {
  const { map, update } = createSignalMap<Command>();
  return {
    register(id, command) {
      update(id, command);
      return () => {
        if (map().get(id) === command) update(id, undefined);
      };
    },
    get: (id) => map().get(id),
    run: (id) => map().get(id)?.run(),
  };
}
