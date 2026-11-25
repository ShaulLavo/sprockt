import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { navigate } from "../app/router";
import { browserWorkspaceDeps, openUnlessCancelled } from "../importer/browser-deps";
import { COPY } from "../importer/copy";
import { importErrorMessage } from "../importer/messages";
import { createWorkspaceWithFiles } from "../importer/new-workspace";
import { BLANK_TEMPLATE } from "./templates";
import { restoreShare } from "./share-workspace";
import "../importer/importer.css";

async function openShare(fragment: string, signal: AbortSignal): Promise<string | undefined> {
  const restored = await restoreShare(fragment);
  if (!restored.ok) return COPY.errors.shareLinkInvalid;
  signal.throwIfAborted();
  const id = await createWorkspaceWithFiles(
    restored.files,
    {
      name: COPY.share.sharedName,
      created: new Date().toISOString(),
      source: { kind: "share", template: restored.template },
      ...(restored.template === BLANK_TEMPLATE ? {} : { template: restored.template }),
    },
    browserWorkspaceDeps,
    { signal },
  );
  openUnlessCancelled(id, signal);
  return undefined;
}

/**
 * `/s#share=…`: writes the shared project into a new workspace, then opens it. A new fragment on
 * the same page (pasted into the address bar) cancels the previous attempt and starts over.
 */
export function SharePage() {
  const [error, setError] = createSignal<string>();
  const [fragment, setFragment] = createSignal(location.hash);
  const followHash = () => setFragment(location.hash);
  addEventListener("hashchange", followHash);
  onCleanup(() => removeEventListener("hashchange", followHash));

  async function attempt(link: string, signal: AbortSignal): Promise<void> {
    try {
      const message = await openShare(link, signal);
      if (!signal.aborted) setError(message);
    } catch (failure) {
      if (!signal.aborted) setError(importErrorMessage(failure));
    }
  }

  createEffect(() => {
    const controller = new AbortController();
    setError(undefined);
    void attempt(fragment(), controller.signal);
    onCleanup(() => controller.abort());
  });

  return (
    <main class="importer" data-testid="share-page" data-stage={error() ? "failed" : "opening"}>
      <section class="importer-card" aria-live="polite">
        <h1 class="importer-title">{COPY.share.openingShare}</h1>
        <Show
          when={error()}
          fallback={
            <>
              <p class="importer-stage">{COPY.importer.opening}</p>
              <div class="importer-progress" role="progressbar" aria-label={COPY.importer.opening} />
            </>
          }
        >
          {(message) => (
            <>
              <p class="importer-error" role="alert" data-testid="share-error">
                {message()}
              </p>
              <div class="importer-actions">
                <button type="button" class="importer-button" onClick={() => navigate({ kind: "landing" })}>
                  {COPY.importer.backHome}
                </button>
              </div>
            </>
          )}
        </Show>
      </section>
    </main>
  );
}
