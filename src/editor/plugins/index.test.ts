import { afterEach, expect, test } from "bun:test";
import type { EditorPlugin } from "@singapore-editor/core/extensions";
import type { Runtime } from "waffle";
import {
  mountEditorPlugins,
  registerEditorPlugins,
  type EditorHostContext,
  type EditorPluginProvider,
} from ".";

const host = {
  runtime: {} as Runtime,
  projectRoot: "/workspace",
  rootUri: "file:///workspace",
  openFile: () => false,
};
const plugin = (name: string): EditorPlugin => ({ name, activate: () => undefined });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const registered: (() => void)[] = [];
const register = (provider: EditorPluginProvider) => registered.push(registerEditorPlugins(provider));
afterEach(() => {
  for (const remove of registered.splice(0)) remove();
});

/** A stand-in for Singapore's Editor that records which plugins are mounted, in mount order. */
function fakeEditor() {
  const live: string[] = [];
  return {
    live,
    addPlugin(added: EditorPlugin) {
      const name = added.name ?? "unnamed";
      live.push(name);
      return { dispose: () => live.splice(live.indexOf(name), 1) };
    },
  };
}

function quietly<T>(run: () => Promise<T>): Promise<T> {
  const original = console.error;
  console.error = () => {};
  return run().finally(() => (console.error = original));
}

test("a provider's plugins mount on a live editor, and the provider sees the workspace", async () => {
  const editor = fakeEditor();
  const stop = mountEditorPlugins(host, editor);
  let seen: EditorHostContext | undefined;
  const unregister = registerEditorPlugins((context) => {
    seen = context;
    return [plugin("test.mounted")];
  });
  await tick();
  expect(editor.live).toEqual(["test.mounted"]);
  expect(seen?.rootUri).toBe("file:///workspace");
  unregister();
  expect(editor.live).toEqual([]);
  expect(seen?.signal.aborted).toBe(true);
  stop();
});

test("providers registered before the editor opens mount when it does", async () => {
  register(async () => [plugin("test.early")]);
  const editor = fakeEditor();
  const stop = mountEditorPlugins(host, editor);
  await tick();
  expect(editor.live).toEqual(["test.early"]);
  stop();
  expect(editor.live).toEqual([]);
});

test("a provider that throws synchronously, rejects or never answers holds back no other provider", () =>
  quietly(async () => {
    register(() => {
      throw new Error("broken provider");
    });
    register(() => Promise.reject(new Error("rejects")));
    register(() => new Promise<EditorPlugin[]>(() => {}));
    register(() => [plugin("test.healthy")]);
    const editor = fakeEditor();
    const stop = mountEditorPlugins(host, editor);
    await tick();
    expect(editor.live).toEqual(["test.healthy"]);
    stop();
  }));

test("plugins are added as providers deliver, in delivery order", async () => {
  const slow = Promise.withResolvers<EditorPlugin[]>();
  register(() => slow.promise);
  register(() => [plugin("first")]);
  const editor = fakeEditor();
  const stop = mountEditorPlugins(host, editor);
  await tick();
  expect(editor.live).toEqual(["first"]);
  slow.resolve([plugin("second")]);
  await tick();
  expect(editor.live).toEqual(["first", "second"]);
  stop();
});

test("closing the editor aborts the signal and disposes what was delivered", async () => {
  let aborted = false;
  let disposed = 0;
  register((context) => {
    context.signal.addEventListener("abort", () => (aborted = true));
    return { plugins: [plugin("lsp")], dispose: () => (disposed += 1) };
  });
  const editor = fakeEditor();
  const stop = mountEditorPlugins(host, editor);
  await tick();
  expect(editor.live).toEqual(["lsp"]);
  stop();
  expect(aborted).toBe(true);
  expect(disposed).toBe(1);
  expect(editor.live).toEqual([]);
});

test("a set that arrives after the editor closed is disposed and never mounted", async () => {
  const late = Promise.withResolvers<{ plugins: EditorPlugin[]; dispose(): void }>();
  let disposed = false;
  register(() => late.promise);
  const editor = fakeEditor();
  const stop = mountEditorPlugins(host, editor);
  await tick();
  stop();
  late.resolve({ plugins: [plugin("late")], dispose: () => (disposed = true) });
  await tick();
  expect(disposed).toBe(true);
  expect(editor.live).toEqual([]);
});
