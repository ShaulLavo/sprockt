// The bridge from the reactive core (src/lib/reactive.ts) to React: components read engine
// signals and memos with `useValue`, and own engine stores that need a scope with `useScope` / `Scope`.
import { useEffect, useEffectEvent, useState, useSyncExternalStore, type ReactNode } from "react";
import { createReaction, createRoot, type Accessor } from "./reactive";

/** Re-renders its component when anything the last read depended on changes. */
class Tracker {
  private version = 0;
  private notify: (() => void) | undefined;
  private subscribed = false;
  readonly reaction = createReaction(() => {
    this.version++;
    this.notify?.();
  });

  readonly subscribe = (notify: () => void): (() => void) => {
    // A second subscription follows an unsubscribe that dropped the dependencies: render again
    // so the read tracks them anew.
    if (this.subscribed) this.version++;
    this.subscribed = true;
    this.notify = notify;
    return () => {
      this.notify = undefined;
      this.reaction.dispose();
    };
  };

  readonly snapshot = (): number => this.version;
}

/**
 * Reads reactive state in a component: returns `read()` and re-renders when what it read
 * changes. `read` may return a fresh object each time; only its dependencies matter.
 */
export function useValue<T>(read: Accessor<T>): T {
  const [tracker] = useState(() => new Tracker());
  useSyncExternalStore(tracker.subscribe, tracker.snapshot, tracker.snapshot);
  return tracker.reaction.track(read);
}

/**
 * Creates something that needs a reactive scope (it calls `onCleanup` or `createEffect`) after
 * the component commits, and disposes the scope when it unmounts. Keeping scope creation out of
 * render ensures an abandoned render never leaves timers, listeners or BroadcastChannels running.
 */
export function useScope<T>(factory: () => T): T | undefined {
  const [value, setValue] = useState<T>();
  const create = useEffectEvent(factory);
  useEffect(() => {
    const scope = createRoot((dispose) => ({ value: create(), dispose }));
    setValue(() => scope.value);
    return () => {
      scope.dispose();
      setValue(undefined);
    };
  }, []);
  return value;
}

/** Mounts `children` once its reactive scope is created in an effect, and disposes it on unmount. */
export function Scope<T>(props: {
  readonly create: () => T;
  readonly fallback?: ReactNode;
  readonly children: (value: T) => ReactNode;
}): ReactNode {
  const value = useScope(props.create);
  return value === undefined ? (props.fallback ?? null) : props.children(value);
}
