import { createResource, For, Show } from "solid-js";
import { storedWorkspaces } from "waffle";
import { navigate } from "../app/router";
import { newWorkspaceId, workspaceIdOf } from "../workspace/paths";
import "./landing.css";

async function savedWorkspaceIds(): Promise<string[]> {
  const stored = await storedWorkspaces("fast");
  return stored.flatMap((name) => workspaceIdOf(name) ?? []).sort();
}

const open = (id: string) => navigate({ kind: "workspace", id });

export function Landing() {
  const [saved] = createResource(savedWorkspaceIds, { initialValue: [] });

  return (
    <main class="landing">
      <h1>Sprockt</h1>
      <button
        type="button"
        class="primary"
        data-testid="new-workspace"
        onClick={() => open(newWorkspaceId())}
      >
        New workspace
      </button>
      <Show when={saved().length > 0}>
        <h2>Workspaces</h2>
        <ul class="workspace-list" data-testid="workspace-list">
          <For each={saved()}>
            {(id) => (
              <li>
                <button type="button" onClick={() => open(id)}>
                  {id}
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </main>
  );
}
