import { expect, test } from "bun:test";
import { portLabel, serverStatus } from "./server-status";

const stop = () => {};

test("a port prints as a colon and the number, with no space", () => {
  expect(portLabel(5173)).toBe(":5173");
});

test("no server and nothing starting leaves the pill empty", () => {
  expect(serverStatus({ port: undefined, task: "stopped", stop })).toBeUndefined();
});

test("a server started in the terminal shows its port and has no stop button", () => {
  const item = serverStatus({ port: 3000, task: "stopped", stop });
  expect(item?.text).toBe(":3000");
  expect(item?.tone).toBe("ok");
  expect(item?.action).toBeUndefined();
});

test("the pane's own server shows its port and stops from the pill", () => {
  let stopped = 0;
  const item = serverStatus({ port: 5173, task: "running", stop: () => void stopped++ });
  expect(item?.text).toBe(":5173");
  expect(item?.tone).toBe("ok");
  item?.action?.run();
  expect(stopped).toBe(1);
});

test("a server that is still starting can be stopped before it has a port", () => {
  const item = serverStatus({ port: undefined, task: "starting", stop });
  expect(item?.text).not.toContain(":");
  expect(item?.tone).toBeUndefined();
  expect(item?.action?.icon).toBe("stop");
});
