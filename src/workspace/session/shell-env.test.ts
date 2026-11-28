import { expect, test } from "bun:test";
import { previewHostEnv } from "bun-wasm/preview-origins";
import type { ShellSettings } from "../../runtime/boot";
import { withServerEnv } from "./shell-env";

const shell: ShellSettings = {
  wasmUrl: new URL("https://sprockt.dev/guests/x/shell-engine.wasm"),
  workerUrl: new URL("https://sprockt.dev/assets/worker.js"),
  cwd: "/workspace",
  env: { PATH: "/usr/bin", HOME: "/home/guest" },
};

test("every shell learns the preview's host names, so Vite accepts requests that carry them", () => {
  const settings = withServerEnv(shell, previewHostEnv({ domain: "sprockt.dev" }));
  expect(settings.env).toEqual({
    PATH: "/usr/bin",
    HOME: "/home/guest",
    __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: ".sprockt.dev",
  });
  expect(settings.cwd).toBe("/workspace");
  // The settings it started from are another workspace's too: they are not changed.
  expect(shell.env).toEqual({ PATH: "/usr/bin", HOME: "/home/guest" });
});

test("a transport on loopback names, or none, adds nothing", () => {
  expect(withServerEnv(shell, previewHostEnv({ domain: "localhost:4174" })).env).toEqual(shell.env);
  expect(withServerEnv(shell, {}).env).toEqual(shell.env);
});
