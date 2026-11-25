// Watches the workspace filesystem from the page, so the IDE follows changes made by the shell,
// by Bun, or by another tab attached to the same workspace.
import type { Runtime } from "waffle";
import { FilesystemClient } from "waffle/fs/client";
import type { FilesystemWatch } from "waffle/fs/watch";

type OnChange = (names: readonly (string | null)[]) => void;

/** Reports one watch's batches until it ends, and says how it ended. */
async function drain(watch: FilesystemWatch, onChange: OnChange): Promise<"overflow" | "closed"> {
  for (;;) {
    // Batches arrive one after another; there is nothing to run in parallel.
    // oxlint-disable-next-line no-await-in-loop
    const batch = await watch.next();
    if (batch.kind === "events") onChange(batch.events.map((event) => event.name));
    else return batch.kind;
  }
}

async function pump(client: FilesystemClient, signal: AbortSignal, onChange: OnChange): Promise<void> {
  const root = await client.asyncCall("preopen", ["/"]);
  while (!signal.aborted) {
    // oxlint-disable-next-line no-await-in-loop
    const watch = await client.watch(root, { recursive: true, signal });
    // oxlint-disable-next-line no-await-in-loop
    if ((await drain(watch, onChange)) === "closed") return;
    // An overflow ends a watch (Waffle host ABI): some events were lost, which null stands for,
    // and a new watch takes over. A tab that hosted the files closing causes one.
    onChange([null]);
    // oxlint-disable-next-line no-await-in-loop
    await watch.close();
  }
}

/**
 * Calls `onChange` with the paths of every change, relative to the filesystem root. Returns
 * the function that stops watching.
 */
export function watchFilesystem(runtime: Runtime, onChange: OnChange): () => void {
  const lifetime = new AbortController();
  const client = new FilesystemClient(runtime.filesystem.fork());
  pump(client, lifetime.signal, onChange).catch((error: unknown) => {
    if (!lifetime.signal.aborted) console.error("The file watcher stopped", error);
  });
  return () => {
    lifetime.abort();
    client.dispose();
  };
}
