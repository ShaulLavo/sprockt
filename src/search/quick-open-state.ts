// Tracks quick-open's file listing requests and any deferred Enter pressed before the first
// listing arrived. Kept pure so race and failure handling are tested without a DOM.

export interface QuickOpenSession {
  /** Starts a new file listing request and returns its sequence token. */
  beginListing(): number;
  /**
   * Finishes a listing request. `accept` is true only when the dialog is still open and this is
   * the latest request; `submit` is true when an earlier pending Enter should now run.
   */
  finishListing(token: number): { readonly accept: boolean; readonly submit: boolean };
  /** Records a failed listing request, disarming any pending Enter. */
  failListing(token: number): void;
  /**
   * Handles pressing Enter. Returns `"now"` to pick the selected item immediately, or `"wait"`
   * when Enter is deferred until the first listing arrives.
   */
  submit(commandsOnly: boolean): "now" | "wait";
  /** Disarms a pending Enter (called when the query or selection changes). */
  cancelPending(): void;
  /** Marks the dialog closed so late listings are ignored. */
  close(): void;
}

export function createQuickOpenSession(): QuickOpenSession {
  let latest = 0;
  let open = true;
  let listed = false;
  let pendingEnter = false;

  return {
    beginListing() {
      latest += 1;
      return latest;
    },
    finishListing(token) {
      if (!open || token !== latest) return { accept: false, submit: false };
      listed = true;
      const submit = pendingEnter;
      pendingEnter = false;
      return { accept: true, submit };
    },
    failListing(_token) {
      // Any listing failure disarms a pending Enter so a later background refresh never submits
      // something the user did not confirm.
      pendingEnter = false;
    },
    submit(commandsOnly) {
      if (!listed && !commandsOnly) {
        pendingEnter = true;
        return "wait";
      }
      pendingEnter = false;
      return "now";
    },
    cancelPending() {
      pendingEnter = false;
    },
    close() {
      open = false;
      pendingEnter = false;
    },
  };
}
