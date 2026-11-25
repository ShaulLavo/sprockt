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

test("a provider that throws synchronously does not stop the next provider", async () => {
  const good = plugin("good");
  register(() => {
    throw new Error("broken provider");
  });
  register(() => [good]);
  let latest: EditorPlugin[] = [];
  const stop = mountEditorPlugins(host, (plugins) => (latest = plugins));
  await tick();
  expect(latest).toEqual([good]);
  stop();
});

test("a provider that never answers does not hold back the others", async () => {
  const fast = plugin("fast");
  register(() => new Promise<EditorPlugin[]>(() => {}));
  register(async () => [fast]);
  let latest: EditorPlugin[] = [];
  const stop = mountEditorPlugins(host, (plugins) => (latest = plugins));
  await tick();
  expect(latest).toEqual([fast]);
  stop();
});

test("plugins accumulate as providers deliver, in delivery order", async () => {
  const slow = Promise.withResolvers<EditorPlugin[]>();
  const first = plugin("first");
  const second = plugin("second");
  register(() => slow.promise);
  register(() => [first]);
  const seen: EditorPlugin[][] = [];
  const stop = mountEditorPlugins(host, (plugins) => seen.push(plugins));
  await tick();
  slow.resolve([second]);
  await tick();
  expect(seen).toEqual([[first], [first, second]]);
  stop();
});

test("stopping aborts the signal and disposes what was delivered", async () => {
  let aborted = false;
  let disposed = 0;
  register((context) => {
    context.signal.addEventListener("abort", () => (aborted = true));
    return { plugins: [plugin("lsp")], dispose: () => (disposed += 1) };
  });
  const stop = mountEditorPlugins(host, () => {});
  await tick();
  stop();
  expect(aborted).toBe(true);
  expect(disposed).toBe(1);
});

test("a set that arrives after the workspace closed is disposed and never mounted", async () => {
  const late = Promise.withResolvers<{ plugins: EditorPlugin[]; dispose(): void }>();
  let disposed = false;
  let calls = 0;
  register(() => late.promise);
  const stop = mountEditorPlugins(host, () => (calls += 1));
  stop();
  late.resolve({ plugins: [plugin("late")], dispose: () => (disposed = true) });
  await tick();
  expect(disposed).toBe(true);
  expect(calls).toBe(0);
});
