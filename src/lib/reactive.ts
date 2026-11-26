// A small framework-neutral reactive core: signals, memos, effects and ownership scopes with
// the same shape as the subset of Solid the engine used, so engine modules keep their logic and
// only change one import. React reads these values through `useValue` (src/lib/react.ts).
//
// The update algorithm is push-pull with three states, as in Reactively: a write marks direct
// observers dirty and their dependents "check"; a memo recomputes only when read or when an
// effect that depends on it runs, and an effect whose memos all kept their value does not run.

export type Accessor<T> = () => T;
export type Setter<T> = (next: T | ((previous: T) => T)) => T;
export type Signal<T> = [Accessor<T>, Setter<T>];

interface SignalOptions<T> {
  readonly equals?: false | ((previous: T, next: T) => boolean);
}

const CLEAN = 0;
const CHECK = 1;
const DIRTY = 2;
type State = typeof CLEAN | typeof CHECK | typeof DIRTY;

/** An ownership scope: what it created is disposed with it, and its cleanups run then. */
class Scope {
  children: Scope[] = [];
  cleanups: (() => void)[] = [];
  disposed = false;

  constructor(readonly parent: Scope | undefined) {
    parent?.children.push(this);
  }

  disposeOwned(): void {
    const children = this.children;
    this.children = [];
    for (const child of children) child.dispose();
    const cleanups = this.cleanups;
    this.cleanups = [];
    for (const cleanup of cleanups) runCleanup(cleanup);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeOwned();
  }
}

function runCleanup(cleanup: () => void): void {
  try {
    cleanup();
  } catch (error) {
    console.error(error);
  }
}

class Node<T> extends Scope {
  value: T;
  sources: Node<unknown>[] = [];
  observers = new Set<Node<unknown>>();
  state: State = CLEAN;
  readonly equals: (previous: T, next: T) => boolean;

  constructor(
    value: T,
    readonly fn: ((previous: T) => T) | undefined,
    readonly effect: boolean,
    parent: Scope | undefined,
    options?: SignalOptions<T>,
  ) {
    super(parent);
    this.value = value;
    this.equals = options?.equals === false ? () => false : (options?.equals ?? Object.is);
  }

  read(): T {
    if (this.disposed && this.fn) return this.value;
    if (listener && listener !== (this as Node<unknown>)) track(listener, this as Node<unknown>);
    if (this.fn) this.updateIfNecessary();
    return this.value;
  }

  write(next: T): void {
    if (this.equals(this.value, next)) return;
    this.value = next;
    for (const observer of this.observers) observer.mark(DIRTY);
    flushIfIdle();
  }

  mark(state: State): void {
    if (this.state >= state) return;
    if (this.state === CLEAN && this.effect) pendingEffects.push(this as Node<unknown>);
    this.state = state;
    for (const observer of this.observers) observer.mark(CHECK);
  }

  updateIfNecessary(): void {
    if (this.state === CHECK) this.checkSources();
    if (this.state === DIRTY) this.update();
    this.state = CLEAN;
  }

  private checkSources(): void {
    for (const source of this.sources) {
      if (source.fn) source.updateIfNecessary();
      if ((this.state as State) === DIRTY) return;
    }
  }

  update(): void {
    if (this.disposed || !this.fn) return;
    this.disposeOwned();
    for (const source of this.sources) source.observers.delete(this as Node<unknown>);
    this.sources = [];
    const previous = this.value;
    const fn = this.fn;
    this.value = runAs(this as Node<unknown>, () => fn(previous));
    if (this.effect || this.equals(previous, this.value)) return;
    for (const observer of this.observers) observer.state = DIRTY;
  }

  override dispose(): void {
    if (this.disposed) return;
    super.dispose();
    for (const source of this.sources) source.observers.delete(this as Node<unknown>);
    this.sources = [];
  }
}

let listener: Node<unknown> | undefined;
let owner: Scope | undefined;
let batchDepth = 0;
let pendingEffects: Node<unknown>[] = [];

/** Runs `fn` with `node` as both the tracking listener and the owner of what it creates. */
function runAs<T>(node: Node<unknown>, fn: () => T): T {
  const outerListener = listener;
  const outerOwner = owner;
  listener = node;
  owner = node;
  try {
    return fn();
  } finally {
    listener = outerListener;
    owner = outerOwner;
  }
}

function track(node: Node<unknown>, source: Node<unknown>): void {
  if (source.observers.has(node)) return;
  source.observers.add(node);
  node.sources.push(source);
}

function flushIfIdle(): void {
  if (batchDepth === 0) flushEffects();
}

function flushEffects(): void {
  batchDepth++;
  try {
    while (pendingEffects.length > 0) {
      const effects = pendingEffects;
      pendingEffects = [];
      for (const effect of effects) runEffect(effect);
    }
  } finally {
    batchDepth--;
  }
}

function runEffect(effect: Node<unknown>): void {
  if (effect.disposed) return;
  try {
    effect.updateIfNecessary();
  } catch (error) {
    effect.state = CLEAN;
    console.error(error);
  }
}

export function createSignal<T>(value: T, options?: SignalOptions<T>): Signal<T>;
export function createSignal<T>(): Signal<T | undefined>;
export function createSignal<T>(value?: T, options?: SignalOptions<T | undefined>): Signal<T | undefined> {
  const node = new Node<T | undefined>(value, undefined, false, undefined, options);
  const read = () => node.read();
  const write: Setter<T | undefined> = (next) => {
    const resolved = typeof next === "function" ? (next as (previous: T | undefined) => T)(node.value) : next;
    node.write(resolved);
    return resolved;
  };
  return [read, write];
}

export function createMemo<T>(
  fn: (previous: T | undefined) => T,
  initial?: T,
  options?: SignalOptions<T>,
): Accessor<T> {
  const node = new Node<T>(initial as T, fn as (previous: T) => T, false, owner, options);
  node.state = DIRTY;
  node.updateIfNecessary();
  return () => node.read();
}

/** Runs `fn` now (or when the current batch or root finishes), and again when what it read changes. */
export function createEffect<T>(fn: (previous: T | undefined) => T, initial?: T): void {
  const node = new Node<T>(initial as T, fn as (previous: T) => T, true, owner);
  node.state = DIRTY;
  pendingEffects.push(node as Node<unknown>);
  flushIfIdle();
}

/** Runs `fn` once, untracked, after the current batch or root finishes. */
export function onMount(fn: () => void): void {
  createEffect(() => untrack(fn));
}

/** Registers `fn` to run when the current scope is disposed or its computation re-runs. */
export function onCleanup(fn: () => void): void {
  owner?.cleanups.push(fn);
}

/** Runs `fn` in a new scope that lives until `dispose` is called. */
export function createRoot<T>(fn: (dispose: () => void) => T): T {
  const scope = new Scope(undefined);
  const outerOwner = owner;
  const outerListener = listener;
  owner = scope;
  listener = undefined;
  batchDepth++;
  try {
    return fn(() => scope.dispose());
  } finally {
    owner = outerOwner;
    listener = outerListener;
    batchDepth--;
    flushIfIdle();
  }
}

export function untrack<T>(fn: () => T): T {
  const outer = listener;
  listener = undefined;
  try {
    return fn();
  } finally {
    listener = outer;
  }
}

/** Defers effects until `fn` returns, so they see all of its writes at once. */
export function batch<T>(fn: () => T): T {
  batchDepth++;
  try {
    return fn();
  } finally {
    batchDepth--;
    flushIfIdle();
  }
}

type Inputs<S> = S extends readonly Accessor<unknown>[]
  ? { [K in keyof S]: S[K] extends Accessor<infer V> ? V : never }
  : S extends Accessor<infer V>
    ? V
    : never;

/** Makes an effect's dependencies explicit: only `deps` are tracked, and `fn` runs untracked. */
export function on<S extends Accessor<unknown> | readonly Accessor<unknown>[], R>(
  deps: S,
  fn: (input: Inputs<S>, previousInput: Inputs<S> | undefined, previous: R | undefined) => R,
  options?: { readonly defer?: boolean },
): (previous: R | undefined) => R | undefined {
  let previousInput: Inputs<S> | undefined;
  let deferred = options?.defer === true;
  return (previous) => {
    const input = (
      Array.isArray(deps) ? deps.map((dep: Accessor<unknown>) => dep()) : (deps as Accessor<unknown>)()
    ) as Inputs<S>;
    if (deferred) {
      deferred = false;
      previousInput = input;
      return undefined;
    }
    const result = untrack(() => fn(input, previousInput, previous));
    previousInput = input;
    return result;
  };
}

/**
 * Tracks what `fn` reads and calls `invalidate` once when any of it changes, until `track` runs
 * again. This is what lets React re-render on a change without re-running the read itself.
 */
export function createReaction(invalidate: () => void): {
  track<T>(fn: () => T): T;
  dispose(): void;
} {
  let current: Node<undefined> | undefined;
  const drop = () => {
    current?.dispose();
    current = undefined;
  };
  return {
    track(fn) {
      drop();
      let first = true;
      let result!: ReturnType<typeof fn>;
      const node = new Node<undefined>(
        undefined,
        () => {
          if (first) {
            first = false;
            result = fn();
            return undefined;
          }
          drop();
          invalidate();
          return undefined;
        },
        true,
        undefined,
      );
      current = node;
      node.update();
      return result;
    },
    dispose: drop,
  };
}
