import { createSignal, Show } from "solid-js";
import type { WorkspaceSession } from "../workspace/session";
import { COPY } from "../importer/copy";
import { prepareShare, sessionShareSource } from "./share-workspace";
import "./share.css";

type ShareState =
  | { readonly kind: "idle" }
  | { readonly kind: "busy" }
  | { readonly kind: "link"; readonly url: string; readonly copied: boolean }
  | { readonly kind: "error"; readonly message: string };

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // No clipboard permission (or an insecure context): the link is shown to copy by hand.
    return false;
  }
}

/**
 * The workbench's Share control. It makes a link holding the workspace's changes, copies it, and
 * shows it. The workbench header places it with one line: `<ShareButton session={session} />`.
 */
export function ShareButton(props: { session: Pick<WorkspaceSession, "files" | "runtime"> }) {
  const [state, setState] = createSignal<ShareState>({ kind: "idle" });

  async function share(): Promise<void> {
    setState({ kind: "busy" });
    const outcome = await prepareShare(sessionShareSource(props.session), location.origin);
    if (outcome.kind === "error") {
      setState(outcome);
      return;
    }
    setState({ kind: "link", url: outcome.url, copied: await copy(outcome.url) });
  }

  const link = () => {
    const current = state();
    return current.kind === "link" ? current : undefined;
  };
  const failure = () => {
    const current = state();
    return current.kind === "error" ? current.message : undefined;
  };

  return (
    <div class="share" data-testid="share">
      <button
        type="button"
        class="share-button"
        data-testid="share-button"
        disabled={state().kind === "busy"}
        onClick={() => void share()}
      >
        {COPY.placeholder.share}
      </button>
      <Show when={link()}>
        {(ready) => (
          <div class="share-popover" role="status">
            <Show when={ready().copied} fallback={<span>{COPY.placeholder.shareReady}</span>}>
              <span data-testid="share-copied">{COPY.placeholder.shareCopied}</span>
            </Show>
            <input
              class="share-link"
              data-testid="share-link"
              readonly
              value={ready().url}
              aria-label={COPY.placeholder.shareReady}
              onFocus={(event) => event.currentTarget.select()}
            />
          </div>
        )}
      </Show>
      <Show when={failure()}>
        {(message) => (
          <p class="share-popover share-error" role="alert" data-testid="share-error">
            {message()}
          </p>
        )}
      </Show>
    </div>
  );
}
