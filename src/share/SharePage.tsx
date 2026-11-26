import { useEffect, useState } from "react";
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
  const [error, setError] = useState<string>();
  const [fragment, setFragment] = useState(() => location.hash);

  useEffect(() => {
    const followHash = () => setFragment(location.hash);
    // The hash may have changed between the first render and this listener.
    followHash();
    addEventListener("hashchange", followHash);
    return () => removeEventListener("hashchange", followHash);
  }, []);

  async function attempt(link: string, signal: AbortSignal): Promise<void> {
    try {
      const message = await openShare(link, signal);
      if (!signal.aborted) setError(message);
    } catch (failure) {
      if (!signal.aborted) setError(importErrorMessage(failure));
    }
  }

  // One attempt per fragment: a new fragment aborts the previous one, as does leaving the page.
  useEffect(() => {
    const controller = new AbortController();
    setError(undefined);
    void attempt(fragment, controller.signal);
    return () => controller.abort();
  }, [fragment]);

  return (
    <main className="importer" data-testid="share-page" data-stage={error ? "failed" : "opening"}>
      <section className="importer-card" aria-live="polite">
        <h1 className="importer-title">{COPY.share.openingShare}</h1>
        {error ? (
          <>
            <p className="importer-error" role="alert" data-testid="share-error">
              {error}
            </p>
            <div className="importer-actions">
              <button type="button" className="importer-button" onClick={() => navigate({ kind: "landing" })}>
                {COPY.importer.backHome}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="importer-stage">{COPY.importer.opening}</p>
            <div className="importer-progress" role="progressbar" aria-label={COPY.importer.opening} />
          </>
        )}
      </section>
    </main>
  );
}
