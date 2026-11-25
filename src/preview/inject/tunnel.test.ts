import { expect, test } from "bun:test";
import { tunnelTarget } from "./tunnel";

const page = new URL("https://ide.test/__preview/abc/5173/index.html");
const server = { port: 5173, mount: "/__preview/abc/5173" };

test("a socket to the page's own host is the dev server's, at the path it asked for", () => {
  // Vite's client builds its URL from the host the page was loaded from.
  expect(tunnelTarget("wss://ide.test/?token=abc", page, server)).toEqual({
    port: 5173,
    target: "/?token=abc",
    url: "wss://ide.test/?token=abc",
  });
});

test("a socket under the mount loses the mount, since the server does not know it", () => {
  expect(tunnelTarget("wss://ide.test/__preview/abc/5173/ws?x=1", page, server)?.target).toBe("/ws?x=1");
  expect(tunnelTarget("wss://ide.test/__preview/abc/5173", page, server)?.target).toBe("/");
});

test("a socket to the server's port on loopback is the dev server's too", () => {
  expect(tunnelTarget("ws://localhost:5173/hmr", page, server)?.target).toBe("/hmr");
  expect(tunnelTarget("ws://127.0.0.1:5173/", page, server)?.target).toBe("/");
});

test("http and relative URLs are understood as sockets on the page's host", () => {
  expect(tunnelTarget("https://ide.test/socket", page, server)?.url).toBe("wss://ide.test/socket");
  expect(tunnelTarget("/socket", page, server)?.target).toBe("/socket");
});

test("a socket anywhere else stays a real socket", () => {
  expect(tunnelTarget("wss://api.example.com/live", page, server)).toBeUndefined();
  expect(tunnelTarget("ws://localhost:9999/other-server", page, server)).toBeUndefined();
  expect(tunnelTarget("ftp://ide.test/file", page, server)).toBeUndefined();
});

test("another server's mount on the same host is not rewritten", () => {
  expect(tunnelTarget("wss://ide.test/__preview/abc/3000/ws", page, server)?.target).toBe(
    "/__preview/abc/3000/ws",
  );
});
