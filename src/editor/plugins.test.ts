import { afterEach, expect, test } from "bun:test";
import type { EditorPlugin } from "@singapore-editor/core/extensions";
import type { Runtime } from "waffle";
import { mountEditorPlugins, registerEditorPlugins, type EditorPluginProvider } from "./plugins";

const host = { runtime: {} as Runtime, projectRoot: "/workspace", rootUri: "file:///workspace" };
const plugin = (name: string) => ({ name }) as unknown as EditorPlugin;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const registered: (() => void)[] = [];
const register = (provider: EditorPluginProvider) => registered.push(registerEditorPlugins(provider));
afterEach(() => {
  for (const remove of registered.splice(0)) remove();
});

/** Mounts and collects every delivery, as the editor pane would add them. */
function mounted() {
  const deliveries: (readonly EditorPlugin[])[] = [];
  const stop = mountEditorPlugins(host, (plugins) => deliveries.push(plugins));
  return { deliveries, stop };
}

test("a provider that throws synchronously does not stop the next provider", async () => {
  const good = plugin("good");
  register(() => {
    throw new Error("broken provider");
  });
  register(() => [good]);
  const { deliveries, stop } = mounted();
  await tick();
  expect(deliveries).toEqual([[good]]);
  stop();
});

test("a provider that never answers does not hold back the others", async () => {
  const fast = plugin("fast");
  register(() => new Promise<EditorPlugin[]>(() => {}));
  register(async () => [fast]);
  const { deliveries, stop } = mounted();
  await tick();
  expect(deliveries).toEqual([[fast]]);
  stop();
});

test("each provider's plugins are delivered once, when that provider answers", async () => {
  const slow = Promise.withResolvers<EditorPlugin[]>();
  const first = plugin("first");
  const second = plugin("second");
  register(() => slow.promise);
  register(() => [first]);
  const { deliveries, stop } = mounted();
  await tick();
  slow.resolve([second]);
  await tick();
  expect(deliveries).toEqual([[first], [second]]);
  stop();
});

test("a provider registered while a workspace is open reaches that workspace", async () => {
  const { deliveries, stop } = mounted();
  const late = plugin("late");
  register(() => [late]);
  await tick();
  expect(deliveries).toEqual([[late]]);
  stop();
});

test("stopping aborts the signal and disposes what was delivered", async () => {
  let aborted = false;
  let disposed = 0;
  register((context) => {
    context.signal.addEventListener("abort", () => (aborted = true));
    return { plugins: [plugin("lsp")], dispose: () => (disposed += 1) };
  });
  const { stop } = mounted();
  await tick();
  stop();
  expect(aborted).toBe(true);
  expect(disposed).toBe(1);
});

test("a set whose dispose throws does not keep the next set from being disposed", async () => {
  let disposed = false;
  register(() => ({
    plugins: [plugin("broken")],
    dispose: () => {
      throw new Error("dispose failed");
    },
  }));
  register(() => ({ plugins: [plugin("fine")], dispose: () => (disposed = true) }));
  const { stop } = mounted();
  await tick();
  stop();
  expect(disposed).toBe(true);
});

test("a set that arrives after the workspace closed is disposed and never delivered", async () => {
  const late = Promise.withResolvers<{ plugins: EditorPlugin[]; dispose(): void }>();
  let disposed = false;
  register(() => late.promise);
  const { deliveries, stop } = mounted();
  stop();
  late.resolve({ plugins: [plugin("late")], dispose: () => (disposed = true) });
  await tick();
  expect(disposed).toBe(true);
  expect(deliveries).toEqual([]);
});
