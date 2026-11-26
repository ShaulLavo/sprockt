// Autosave: unsaved edits are saved about a second after the last keystroke, and at once when the
// page is hidden, the editor loses focus or another file is shown. A phone with no keyboard has no
// Ctrl+S, so without this an edit would never reach the disk or the preview.
//
// Autosave only ever calls `BufferSet.save`, the same path Ctrl+S takes: saves of one file stay in
// order, a moved file's save waits for its lock, and a file that changed on disk turns into a
// conflict instead of being overwritten. A buffer that already has a conflict, whose file was
// deleted, or that was pushed aside by a move is left alone: those wait for the person to choose.

/** How long after the last edit autosave waits, in milliseconds. */
export const AUTOSAVE_DELAY = 1000;

/** What autosave reads of a buffer to decide whether it may write it. */
export interface AutosaveBuffer {
  readonly path: string;
  dirty(): boolean;
  conflict(): unknown;
  missing(): boolean;
}

export interface AutosaveBuffers {
  paths(): readonly string[];
  get(path: string): AutosaveBuffer | undefined;
  /** `when` is asked right before the write starts; false: nothing is written. */
  save(path: string, options: { when(buffer: AutosaveBuffer): boolean }): Promise<void>;
}

export interface AutosaveTimers {
  set(run: () => void, delay: number): unknown;
  clear(handle: unknown): void;
}

export interface AutosaveOptions {
  readonly buffers: AutosaveBuffers;
  /** The person's setting; read each time, so turning it off stops a pending save. */
  enabled(): boolean;
  /** False once another tab owns the workspace: nothing can be written then. */
  writable(): boolean;
  /** A detached draft (moved aside) has no file of its own to save to. */
  isDetached(path: string): boolean;
  readonly delay?: number;
  readonly timers?: AutosaveTimers;
  /** A save that threw (storage refused it). The buffer stays unsaved. */
  onError?(error: unknown): void;
}

export interface Autosave {
  /** An edit was made: the idle wait starts again. */
  edited(): void;
  /** Saves every buffer autosave may write, now. Resolves when those saves have settled. */
  flush(): Promise<void>;
  dispose(): void;
}

const browserTimers: AutosaveTimers = {
  set: (run, delay) => setTimeout(run, delay),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Unsaved, with no conflict waiting for the person and a file to write to. A deleted file is not
 * written again behind the person's back: they save it on purpose if they want it back.
 */
export function autosavable(buffer: AutosaveBuffer, isDetached: (path: string) => boolean): boolean {
  if (!buffer.dirty()) return false;
  if (buffer.conflict() !== undefined) return false;
  if (buffer.missing()) return false;
  return !isDetached(buffer.path);
}

export function createAutosave(options: AutosaveOptions): Autosave {
  const timers = options.timers ?? browserTimers;
  const delay = options.delay ?? AUTOSAVE_DELAY;
  let pending: unknown;
  let disposed = false;

  function cancel(): void {
    if (pending === undefined) return;
    timers.clear(pending);
    pending = undefined;
  }

  const allowed = () => !disposed && options.enabled() && options.writable();

  /**
   * Asked again right before each write starts, after earlier saves of the file and any move lock:
   * the file may have been deleted, or the text written, while the save waited.
   */
  const stillWanted = (buffer: AutosaveBuffer) => allowed() && autosavable(buffer, options.isDetached);

  function savable(): AutosaveBuffer[] {
    return options.buffers.paths().flatMap((path) => {
      const buffer = options.buffers.get(path);
      return buffer !== undefined && autosavable(buffer, options.isDetached) ? [buffer] : [];
    });
  }

  /** Per buffer: the autosave running now, and whether another was asked for meanwhile. */
  interface Running {
    again: boolean;
    done: Promise<void>;
  }
  const running = new Map<AutosaveBuffer, Running>();

  async function saveWhileWanted(buffer: AutosaveBuffer, state: Running): Promise<void> {
    try {
      do {
        state.again = false;
        // oxlint-disable-next-line no-await-in-loop -- one save of a buffer at a time, by design
        await options.buffers
          .save(buffer.path, { when: stillWanted })
          .catch((error: unknown) => options.onError?.(error));
      } while (state.again && allowed());
    } finally {
      // No await between the last check of `again` and this: a request is never dropped.
      running.delete(buffer);
    }
  }

  /**
   * At most one autosave per buffer is queued: asking while one runs asks for one more after it,
   * however often it is asked, and that one writes only if an unsaved edit is still there.
   */
  function autosave(buffer: AutosaveBuffer): Promise<void> {
    const current = running.get(buffer);
    if (current) {
      current.again = true;
      return current.done;
    }
    const state: Running = { again: false, done: Promise.resolve() };
    running.set(buffer, state);
    state.done = saveWhileWanted(buffer, state);
    return state.done;
  }

  async function flush(): Promise<void> {
    cancel();
    if (!allowed()) return;
    await Promise.all(savable().map(autosave));
  }

  return {
    edited() {
      if (disposed || !options.enabled()) return;
      cancel();
      pending = timers.set(() => {
        pending = undefined;
        void flush();
      }, delay);
    },
    flush,
    dispose() {
      cancel();
      disposed = true;
    },
  };
}

/** The setting is per browser, not per workspace. Anything but "off" means on. */
export const AUTOSAVE_SETTING_KEY = "sprockt:editor-autosave";

type SettingStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function loadAutosaveSetting(storage: SettingStore): boolean {
  try {
    return storage.getItem(AUTOSAVE_SETTING_KEY) !== "off";
  } catch {
    return true;
  }
}

export function storeAutosaveSetting(storage: SettingStore, enabled: boolean): void {
  try {
    if (enabled) storage.removeItem(AUTOSAVE_SETTING_KEY);
    else storage.setItem(AUTOSAVE_SETTING_KEY, "off");
  } catch {
    // Storage blocked or full: the setting holds for this page only.
  }
}
