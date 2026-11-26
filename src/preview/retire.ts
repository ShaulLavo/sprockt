// A build without previews takes down the preview service worker that an earlier build on this
// origin registered. Without this, a tab of the earlier build that is still open keeps
// answering navigations to `/__preview/…` through that worker after the new build is live.
//
// The worker is told, unregistered, and flagged as retired in the origin's cache storage. The
// flag is what a worker reads when the browser starts it again for a page it still controls:
// being told lasts only as long as that worker's memory (retirement.ts).
import { PREVIEWS_OFF } from "./host-protocol";
import { PREVIEW_PREFIX } from "./paths";
import { retiredFlag, type RetiredFlag } from "./retirement";

type Registration = Pick<
  ServiceWorkerRegistration,
  "scope" | "active" | "waiting" | "installing" | "unregister"
>;

export interface WorkerRegistrations {
  getRegistrations(): Promise<readonly Registration[]>;
}

async function retire(registration: Registration): Promise<void> {
  // Told first: a worker stays in charge of the pages it already controls after it is
  // unregistered, and this makes it stop answering them too.
  for (const worker of [registration.active, registration.waiting, registration.installing]) {
    // A service worker takes no target origin: it is this origin's own worker.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    worker?.postMessage({ type: PREVIEWS_OFF });
  }
  await registration.unregister();
}

/** Removes this origin's preview worker, if a build before this one left one. Resolves with how many. */
export async function retirePreviewWorker(
  container: WorkerRegistrations | undefined = navigator.serviceWorker,
  origin: string = location.origin,
  flag: Pick<RetiredFlag, "set"> = retiredFlag(globalThis.caches),
): Promise<number> {
  if (!container) return 0;
  const scope = `${origin}${PREVIEW_PREFIX}/`;
  const stale = (await container.getRegistrations()).filter((registration) => registration.scope === scope);
  if (stale.length === 0) return 0;
  // Before the worker is told or removed: whatever happens to it next, the flag is already there.
  await flag.set().catch(() => {});
  await Promise.all(stale.map(retire));
  return stale.length;
}
