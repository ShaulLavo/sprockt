import { createSignal, onCleanup, Show } from "solid-js";
import { useWorkspace } from "../workspace/session";
import type { PreviewServer } from "./transport";

export function PreviewPane() {
  const { preview } = useWorkspace();
  const [servers, setServers] = createSignal<readonly PreviewServer[]>(preview.servers());
  onCleanup(preview.subscribe(setServers));
  const first = () => servers()[0];

  return (
    <section class="pane preview-pane" aria-label="Preview">
      <header class="pane-header">
        <span>Preview</span>
      </header>
      <Show
        when={first()}
        fallback={
          <p class="pane-empty">
            No dev server is running yet. Start one in the terminal to preview it here.
          </p>
        }
      >
        {(server) => (
          <iframe class="preview-frame" title="Preview" src={preview.frameUrl(server().port, "/")} />
        )}
      </Show>
    </section>
  );
}
