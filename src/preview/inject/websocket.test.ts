import { afterEach, expect, test } from "bun:test";
import { acceptFor, closePayload } from "../websocket-frames";
import { endTunnels, TunnelWebSocket } from "./websocket";

const TARGET = { port: 3000, target: "/ws", url: "ws://localhost:3000/ws" };
const encoder = new TextEncoder();

/** A server's text frame: servers do not mask, and these payloads are short. */
const textFrame = (text: string) => {
  const payload = encoder.encode(text);
  return new Uint8Array([0x81, payload.length, ...payload]);
};

/** A server's close frame. */
const closeFrame = (code: number, reason: string) => {
  const payload = closePayload(code, reason);
  return new Uint8Array([0x88, payload.length, ...payload]);
};

const joined = (...parts: Uint8Array[]) => new Uint8Array(parts.flatMap((part) => Array.from(part)));

const until = async (done: () => boolean) => {
  for (let turn = 0; turn < 200 && !done(); turn++) {
    // oxlint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  expect(done()).toBe(true);
};

const ports: MessagePort[] = [];
afterEach(() => {
  endTunnels();
  for (const port of ports.splice(0)) port.close();
});

/** Whether the server's end was told that the socket is over. */
const ended = (received: unknown[]) =>
  received.some((message) => (message as { type?: string }).type === "end");

/** A socket and the server's end of its channel. `events` records what the page would see. */
function connect() {
  const received: unknown[] = [];
  let far: MessagePort | undefined;
  const socket = new TunnelWebSocket(TARGET, [], (port) => {
    far = port;
    ports.push(port);
    port.addEventListener("message", (event: MessageEvent<unknown>) => received.push(event.data));
    port.start();
    return true;
  });
  const events: string[] = [];
  socket.addEventListener("open", () => events.push(`open state=${socket.readyState}`));
  socket.addEventListener("message", (event) =>
    events.push(`message ${String((event as MessageEvent).data)} state=${socket.readyState}`),
  );
  socket.addEventListener("close", (event) => {
    const { code, wasClean } = event as CloseEvent;
    events.push(`close ${code} clean=${wasClean}`);
  });
  // A message port has no target origin: it reaches its other end only.
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  const say = (message: unknown) => far?.postMessage(message);
  const send = (chunk: Uint8Array) => say({ type: "data", chunk });

  /** Accepts the channel, reads the socket's request and returns the answer a server gives. */
  async function answer(): Promise<Uint8Array> {
    say({ type: "accepted" });
    await until(() => received.length > 0);
    const request = new TextDecoder().decode((received[0] as { chunk: Uint8Array }).chunk);
    const key = /sec-websocket-key: (\S+)/i.exec(request)?.[1] ?? "";
    const lines = [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${await acceptFor(key)}`,
    ];
    return encoder.encode(`${lines.join("\r\n")}\r\n\r\n`);
  }

  return { socket, events, received, send, say, answer };
}

test("a frame that arrives right behind the handshake is delivered after open, not before", async () => {
  const { socket, events, send, answer } = connect();
  const handshake = await answer();
  send(handshake);
  send(textFrame("first"));
  await until(() => events.length >= 2);
  expect(events).toEqual([`open state=${socket.OPEN}`, `message first state=${socket.OPEN}`]);
});

test("a frame split across the handshake's chunk and the next is put together in order", async () => {
  const { events, send, answer } = connect();
  const handshake = await answer();
  const frame = textFrame("hello world");
  send(joined(handshake, frame.subarray(0, 4)));
  send(frame.subarray(4));
  send(textFrame("second"));
  await until(() => events.length >= 3);
  expect(events.slice(1)).toEqual(["message hello world state=1", "message second state=1"]);
  expect(events[0]).toBe("open state=1");
});

test("frames after the handshake still arrive one by one in order", async () => {
  const { events, send, answer } = connect();
  send(await answer());
  await until(() => events.length >= 1);
  const frame = textFrame("in two parts");
  send(frame.subarray(0, 5));
  send(frame.subarray(5));
  send(joined(textFrame("a"), textFrame("b")));
  await until(() => events.length >= 4);
  expect(events.slice(1)).toEqual(["message in two parts state=1", "message a state=1", "message b state=1"]);
});

test("when the document goes away its open sockets tell the server they ended", async () => {
  const open = connect();
  open.send(await open.answer());
  await until(() => open.events.length >= 1);
  const connecting = connect();

  endTunnels();
  expect(open.socket.readyState).toBe(open.socket.CLOSED);
  expect(connecting.socket.readyState).toBe(connecting.socket.CLOSED);
  await until(() => ended(open.received) && ended(connecting.received));
  expect(open.events.at(-1)).toBe("close 1001 clean=false");
});

test("a server that answers, sends, closes and hangs up at once is heard in that order", async () => {
  const { events, send, say, answer } = connect();
  const handshake = await answer();
  // Everything arrives while the handshake's answer is still being checked.
  send(handshake);
  send(textFrame("only message"));
  send(closeFrame(1000, "bye"));
  say({ type: "end" });
  await until(() => events.some((event) => event.startsWith("close")));
  expect(events).toEqual(["open state=1", "message only message state=1", "close 1000 clean=true"]);
});

test("a server that hangs up right after its first message still delivers it", async () => {
  const { events, send, say, answer } = connect();
  send(joined(await answer(), textFrame("last words")));
  say({ type: "end" });
  await until(() => events.some((event) => event.startsWith("close")));
  // No close frame came, so the close is not a clean one; the message is not lost for it.
  expect(events).toEqual(["open state=1", "message last words state=1", "close 1006 clean=false"]);
});

test("a channel that ends before any answer fails the socket without opening it", async () => {
  const { events, say } = connect();
  say({ type: "accepted" });
  say({ type: "end" });
  await until(() => events.length > 0);
  expect(events).toEqual(["close 1006 clean=false"]);
});

test("a socket that already closed is not ended a second time", async () => {
  const { socket, received, send, answer } = connect();
  send(await answer());
  await until(() => socket.readyState === socket.OPEN);
  socket.abandon();
  endTunnels();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(received.filter((message) => (message as { type?: string }).type === "end")).toHaveLength(1);
});
