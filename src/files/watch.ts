// Watches the workspace filesystem from the page, so the explorer follows changes made by the
// shell, by Bun, or by another tab attached to the same workspace.
import type { Runtime } from "waffle";
import { FilesystemClient } from "waffle/fs/client";
import { touchesProject } from "./tree";

async function pump(client: FilesystemClient, signal: AbortSignal, onChange: () => void): Promise<void> {
  const root = await client.asyncCall("preopen", ["/"]);
  const watch = await client.watch(root, { recursive: true, signal });
  for (;;) {
    // Batches arrive one after another; there is nothing to run in parallel.
    // oxlint-disable-next-line no-await-in-loop
    const batch = await watch.next();
    if (batch.kind === "closed") return;
    // After an overflow some events are lost, so the listing has to be taken again anyway.
    if (batch.kind === "overflow" || touchesProject(batch.events.map((event) => event.name))) onChange();
  }
}

/** Calls `onChange` whenever project files change. Returns the function that stops watching. */
export function watchProject(runtime: Runtime, onChange: () => void): () => void {
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
