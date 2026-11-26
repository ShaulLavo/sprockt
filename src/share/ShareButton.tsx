import { useState } from "react";
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
  const [state, setState] = useState<ShareState>({ kind: "idle" });

  async function share(): Promise<void> {
    setState({ kind: "busy" });
    const outcome = await prepareShare(sessionShareSource(props.session), location.origin);
    if (outcome.kind === "error") {
      setState(outcome);
      return;
    }
    setState({ kind: "link", url: outcome.url, copied: await copy(outcome.url) });
  }

  const link = state.kind === "link" ? state : undefined;
  const failure = state.kind === "error" ? state.message : undefined;

  return (
    <div className="share" data-testid="share">
      <button
        type="button"
        className="share-button"
        data-testid="share-button"
        disabled={state.kind === "busy"}
        onClick={() => void share()}
      >
        {COPY.share.share}
      </button>
      {link ? (
        <div className="share-popover" role="status">
          {link.copied ? (
            <span data-testid="share-copied">{COPY.share.shareCopied}</span>
          ) : (
            <span>{COPY.share.shareReady}</span>
          )}
          <input
            className="share-link"
            data-testid="share-link"
            readOnly
            value={link.url}
            aria-label={COPY.share.shareReady}
            onFocus={(event) => event.currentTarget.select()}
          />
        </div>
      ) : null}
      {failure ? (
        <p className="share-popover share-error" role="alert" data-testid="share-error">
          {failure}
        </p>
      ) : null}
    </div>
  );
}
