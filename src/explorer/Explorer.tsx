import { createResource, For, Show } from "solid-js";
import type { EditorStore } from "../editor/store";
import { buildTree, type TreeNode } from "../files/tree";
import { useWorkspace } from "../workspace/session";
import "./explorer.css";

function Entry(props: { node: TreeNode; depth: number; store: EditorStore }) {
  const indent = () => ({ "padding-left": `${props.depth * 12 + 8}px` });
  return (
    <li>
      <Show
        when={props.node.kind === "file"}
        fallback={
          <span class="tree-row tree-directory" style={indent()}>
            {props.node.name}
          </span>
        }
      >
        <button
          type="button"
          class="tree-row tree-file"
          classList={{ active: props.store.active() === props.node.path }}
          style={indent()}
          onClick={() => props.store.open(props.node.path)}
        >
          {props.node.name}
        </button>
      </Show>
      <Show when={props.node.children.length > 0}>
        <ul>
          <For each={props.node.children}>
            {(child) => <Entry node={child} depth={props.depth + 1} store={props.store} />}
          </For>
        </ul>
      </Show>
    </li>
  );
}

export function Explorer(props: { store: EditorStore }) {
  const workspace = useWorkspace();
  const [tree] = createResource(
    workspace.files.revision,
    async () => buildTree(await workspace.files.list()),
    {
      initialValue: [],
    },
  );

  return (
    <section class="pane explorer-pane" aria-label="Files">
      <header class="pane-header">
        <span>Files</span>
      </header>
      <ul class="tree" data-testid="file-tree">
        <For each={tree.latest} fallback={<li class="tree-empty">No files yet.</li>}>
          {(node) => <Entry node={node} depth={0} store={props.store} />}
        </For>
      </ul>
    </section>
  );
}
