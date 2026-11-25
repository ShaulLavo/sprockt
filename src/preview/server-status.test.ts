import { expect, test } from "bun:test";
import { listedPorts, portLabel, samePorts, serverStatus } from "./server-status";

const stop = () => {};

test("the pane lists its own ports and the owning tab's, each once and in order", () => {
  expect(listedPorts([5173, 3000], [])).toEqual([3000, 5173]);
  expect(listedPorts([3000], [5173, 3000])).toEqual([3000, 5173]);
  expect(listedPorts([], [])).toEqual([]);
  expect(samePorts([3000, 5173], [3000, 5173])).toBe(true);
  expect(samePorts([3000], [3000, 5173])).toBe(false);
});

test("a port prints as a colon and the number, with no space", () => {
  expect(portLabel(5173)).toBe(":5173");
});

test("no server and nothing starting leaves the pill empty", () => {
  expect(serverStatus({ port: undefined, task: "stopped", owned: false, stop })).toBeUndefined();
});

test("a server started in the terminal shows its port and has no stop button", () => {
  const item = serverStatus({ port: 3000, task: "stopped", owned: false, stop });
  expect(item?.text).toBe(":3000");
  expect(item?.tone).toBe("ok");
  expect(item?.action).toBeUndefined();
});

test("the server this tab runs shows its port and stops from the pill", () => {
  let stopped = 0;
  const item = serverStatus({ port: 5173, task: "running", owned: true, stop: () => void stopped++ });
  expect(item?.text).toBe(":5173");
  expect(item?.tone).toBe("ok");
  item?.action?.run();
  expect(stopped).toBe(1);
});

test("a server another tab runs shows the same port, says where it runs, and has no stop button", () => {
  const here = serverStatus({ port: 5173, task: "running", owned: true, stop });
  const elsewhere = serverStatus({ port: 5173, task: "running", owned: false, stop });
  expect(elsewhere?.text).toBe(":5173");
  expect(elsewhere?.tone).toBe("ok");
  expect(elsewhere?.action).toBeUndefined();
  expect(elsewhere?.title).not.toBe(here?.title);
});

test("a server that is still starting here can be stopped before it has a port", () => {
  const item = serverStatus({ port: undefined, task: "starting", owned: true, stop });
  expect(item?.text).not.toContain(":");
  expect(item?.tone).toBeUndefined();
  expect(item?.action?.icon).toBe("stop");
});

test("a server that is starting in another tab shows without a stop button", () => {
  const item = serverStatus({ port: undefined, task: "starting", owned: false, stop });
  expect(item?.text).not.toContain(":");
  expect(item?.action).toBeUndefined();
});
