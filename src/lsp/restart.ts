// When the file watcher may have lost events, the language server has to re-read the disk. The
// way to do that without losing unsaved text is a restart: the connection starts a new server
// and re-opens every editor document with its current text. A restart goes through the same path
// as a crash, so it uses up one of the connection's reconnect attempts unless the server had been
// up for 60 s (Singapore's `LspConnection` resets the count then). Restarts are therefore spaced
// at least that far apart, and a burst of resyncs (an install that overflows the watch more than
// once) becomes one restart once the burst is over.

export interface RestartTiming {
  /** How long resync requests must stop before the restart happens. */
  readonly quietMs: number;
  /** The least time between two restarts. */
  readonly minGapMs: number;
}

export const RESTART_TIMING: RestartTiming = { quietMs: 1000, minGapMs: 60_000 };

export interface Clock {
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface RestartScheduler {
  /** Events may have been lost: restart once things are quiet and the gap allows. */
  request(): void;
  stop(): void;
}

export function createRestartScheduler(
  restart: () => void,
  timing: RestartTiming = RESTART_TIMING,
  clock: Clock = realClock,
): RestartScheduler {
  let last = Number.NEGATIVE_INFINITY;
  let timer: unknown;
  let stopped = false;
  const fire = () => {
    timer = undefined;
    last = clock.now();
    restart();
  };
  return {
    request() {
      if (stopped) return;
      if (timer !== undefined) clock.clearTimeout(timer);
      const delay = Math.max(timing.quietMs, last + timing.minGapMs - clock.now());
      timer = clock.setTimeout(fire, delay);
    },
    stop() {
      stopped = true;
      if (timer !== undefined) clock.clearTimeout(timer);
      timer = undefined;
    },
  };
}
