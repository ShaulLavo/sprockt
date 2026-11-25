// Waffle allows one live runtime per page. This is the turnstile that guarantees it: a
// workspace opens only after the previous one is fully torn down, and a workspace that is
// closed while it is still starting is disposed the moment it arrives.

export interface Disposable {
  dispose(): Promise<void>;
}

export interface Opening<T> {
  /** The session, once the previous one is gone and this one has started. */
  readonly session: Promise<T>;
  /** Ends this workspace, started or not. Resolves when its runtime is gone. */
  close(): Promise<void>;
}

export interface Turnstile {
  open<T extends Disposable>(start: () => Promise<T>): Opening<T>;
  /** Resolves when the workspace opened last has been closed and torn down. */
  idle(): Promise<void>;
}

export function createTurnstile(): Turnstile {
  let gone: Promise<void> = Promise.resolve();

  return {
    idle: () => gone,
    open<T extends Disposable>(start: () => Promise<T>): Opening<T> {
      const session = gone.then(start);
      const torn = Promise.withResolvers<void>();
      gone = torn.promise;
      let closing: Promise<void> | undefined;

      async function tearDown(): Promise<void> {
        try {
          // Waits for a start that is still running: its runtime exists and must be disposed.
          const opened = await session.catch(() => undefined);
          await opened?.dispose();
        } catch (error) {
          console.error("Closing a workspace failed", error);
        } finally {
          torn.resolve();
        }
      }

      return { session, close: () => (closing ??= tearDown()) };
    },
  };
}

/** The page's one turnstile. */
export const workspaceTurnstile = createTurnstile();

/**
 * Runs every teardown step in order, even when an earlier one fails, so a broken service
 * cannot keep the runtime alive. Rethrows what failed once all steps ran.
 */
export async function tearDownAll(steps: readonly (() => unknown)[]): Promise<void> {
  const errors: unknown[] = [];
  const chain = steps.reduce<Promise<void>>(
    (done, step) =>
      done.then(async () => void (await step())).catch((error: unknown) => void errors.push(error)),
    Promise.resolve(),
  );
  await chain;
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Closing the workspace failed");
}
