import { expect, test } from "bun:test";
import {
  acceptFor,
  closePayload,
  encodeFrame,
  FrameDecoder,
  handshakeKey,
  handshakeRequest,
  joinPayloads,
  OPCODE,
  parseClosePayload,
  parseHandshakeResponse,
} from "./websocket-frames";

const text = (value: string) => new TextEncoder().encode(value);
const mask = Uint8Array.of(1, 2, 3, 4);

test("the accept value matches the example in the WebSocket standard", async () => {
  expect(await acceptFor("dGhlIHNhbXBsZSBub25jZQ==")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
});

test("a handshake key is 16 bytes in base64", () => {
  expect(handshakeKey(new Uint8Array(16))).toBe("AAAAAAAAAAAAAAAAAAAAAA==");
  expect(atob(handshakeKey())).toHaveLength(16);
});

test("the upgrade request names the server as it knows itself, and lists protocols", () => {
  const request = new TextDecoder().decode(
    handshakeRequest({ target: "/?token=abc", host: "localhost:5173", key: "KEY", protocols: ["vite-hmr"] }),
  );
  expect(request.split("\r\n")).toEqual([
    "GET /?token=abc HTTP/1.1",
    "Host: localhost:5173",
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Key: KEY",
    "Sec-WebSocket-Version: 13",
    "Origin: http://localhost:5173",
    "Sec-WebSocket-Protocol: vite-hmr",
    "",
    "",
  ]);
});

test("the server's answer is parsed once its head is complete, with what follows it", () => {
  const head = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: abc=\r\n";
  expect(parseHandshakeResponse(text(head))).toBeUndefined();

  const frame = Uint8Array.of(0x81, 2, 104, 105);
  const parsed = parseHandshakeResponse(joinPayloads([text(`${head}\r\n`), frame]));
  expect(parsed?.status).toBe(101);
  expect(parsed?.headers.get("sec-websocket-accept")).toBe("abc=");
  expect(Array.from(parsed?.rest ?? [])).toEqual(Array.from(frame));
});

test("a frame survives encoding and decoding at every length form", () => {
  for (const length of [0, 1, 125, 126, 65_535, 65_536, 70_000]) {
    const payload = Uint8Array.from({ length }, (_value, index) => index % 251);
    const [frame, ...rest] = new FrameDecoder().push(encodeFrame(OPCODE.binary, payload, mask));
    expect(rest).toEqual([]);
    expect(frame?.fin).toBe(true);
    expect(frame?.opcode).toBe(OPCODE.binary);
    expect(frame?.payload.length).toBe(length);
    expect(frame?.payload).toEqual(payload);
  }
});

test("a client frame is masked on the wire", () => {
  const frame = encodeFrame(OPCODE.text, text("hi"), mask);
  expect(Array.from(frame)).toEqual([0x81, 0x82, 1, 2, 3, 4, 104 ^ 1, 105 ^ 2]);
});

test("frames split across arbitrary chunks, and several frames in one chunk, are all found", () => {
  const first = encodeFrame(OPCODE.text, text("first message"), mask);
  const second = Uint8Array.of(0x89, 0);
  const third = Uint8Array.of(0x82, 3, 7, 8, 9);
  const stream = joinPayloads([first, second, third]);

  const decoder = new FrameDecoder();
  const frames = Array.from(stream).flatMap((byte) => decoder.push(Uint8Array.of(byte)));
  expect(frames.map((frame) => frame.opcode)).toEqual([OPCODE.text, OPCODE.ping, OPCODE.binary]);
  expect(new TextDecoder().decode(frames[0]?.payload)).toBe("first message");
  expect(Array.from(frames[2]?.payload ?? [])).toEqual([7, 8, 9]);

  expect(new FrameDecoder().push(stream)).toHaveLength(3);
});

test("a fragmented message keeps its fin flags so it can be joined", () => {
  const stream = joinPayloads([Uint8Array.of(0x01, 3, 104, 101, 108), Uint8Array.of(0x80, 2, 108, 111)]);
  const frames = new FrameDecoder().push(stream);
  expect(frames.map((frame) => [frame.fin, frame.opcode])).toEqual([
    [false, OPCODE.text],
    [true, OPCODE.continuation],
  ]);
  expect(new TextDecoder().decode(joinPayloads(frames.map((frame) => frame.payload)))).toBe("hello");
});

test("a close payload carries a code and a reason, and an empty one means no code", () => {
  expect(parseClosePayload(closePayload(1000, "done"))).toEqual({ code: 1000, reason: "done" });
  expect(closePayload(undefined, "ignored")).toHaveLength(0);
  expect(parseClosePayload(new Uint8Array())).toEqual({ code: 1005, reason: "" });
});
