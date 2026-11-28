// The WebSocket wire format (RFC 6455), client side, as pure functions. A previewed page cannot
// open a real socket to a server that only exists inside the workspace, so the preview client
// speaks the protocol itself over a byte channel to that server.

export const OPCODE = { continuation: 0, text: 1, binary: 2, close: 8, ping: 9, pong: 10 } as const;

export interface Frame {
  readonly fin: boolean;
  readonly opcode: number;
  readonly payload: Uint8Array;
}

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const base64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

/** A fresh `Sec-WebSocket-Key`: 16 random bytes, base64. */
export function handshakeKey(random: Uint8Array = crypto.getRandomValues(new Uint8Array(16))): string {
  return base64(random);
}

/** The `Sec-WebSocket-Accept` value a server must answer `key` with. */
export async function acceptFor(key: string): Promise<string> {
  return base64(new Uint8Array(await crypto.subtle.digest("SHA-1", encoder.encode(key + GUID))));
}

export interface HandshakeRequest {
  /** Path and query on the server. */
  readonly target: string;
  /** The authority the server believes it is reached at, such as `localhost:5173`. */
  readonly host: string;
  readonly key: string;
  readonly protocols: readonly string[];
}

export function handshakeRequest(request: HandshakeRequest): Uint8Array {
  const lines = [
    `GET ${request.target} HTTP/1.1`,
    `Host: ${request.host}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${request.key}`,
    "Sec-WebSocket-Version: 13",
    `Origin: http://${request.host}`,
  ];
  if (request.protocols.length > 0) lines.push(`Sec-WebSocket-Protocol: ${request.protocols.join(", ")}`);
  return encoder.encode(lines.concat(["", ""]).join("\r\n"));
}

export interface HandshakeResponse {
  readonly status: number;
  readonly headers: ReadonlyMap<string, string>;
  /** Bytes that followed the response head: the first frames. */
  readonly rest: Uint8Array;
}

function indexOfHeadEnd(bytes: Uint8Array): number {
  for (let at = 0; at + 3 < bytes.length; at++) {
    if (bytes[at] === 13 && bytes[at + 1] === 10 && bytes[at + 2] === 13 && bytes[at + 3] === 10) return at;
  }
  return -1;
}

/** Parses the server's answer, or returns undefined while the head is still incomplete. */
export function parseHandshakeResponse(bytes: Uint8Array): HandshakeResponse | undefined {
  const end = indexOfHeadEnd(bytes);
  if (end < 0) return undefined;
  const [statusLine = "", ...fields] = decoder.decode(bytes.subarray(0, end)).split("\r\n");
  const headers = new Map<string, string>();
  for (const field of fields) {
    const colon = field.indexOf(":");
    if (colon > 0) headers.set(field.slice(0, colon).trim().toLowerCase(), field.slice(colon + 1).trim());
  }
  return { status: Number(statusLine.split(" ")[1]), headers, rest: bytes.subarray(end + 4) };
}

function lengthBytes(length: number): Uint8Array {
  if (length < 126) return Uint8Array.of(length);
  if (length < 65_536) return Uint8Array.of(126, length >>> 8, length & 0xff);
  const out = new Uint8Array(9);
  out[0] = 127;
  new DataView(out.buffer).setBigUint64(1, BigInt(length));
  return out;
}

/** One final frame from the client: always masked, as the protocol demands. */
export function encodeFrame(opcode: number, payload: Uint8Array, mask: Uint8Array): Uint8Array {
  const length = lengthBytes(payload.length);
  const out = new Uint8Array(1 + length.length + 4 + payload.length);
  out[0] = 0x80 | opcode;
  out.set(length, 1);
  out[1] = (out[1] ?? 0) | 0x80;
  out.set(mask, 1 + length.length);
  const start = 1 + length.length + 4;
  for (let at = 0; at < payload.length; at++) out[start + at] = (payload[at] ?? 0) ^ (mask[at & 3] ?? 0);
  return out;
}

export function closePayload(code: number | undefined, reason: string): Uint8Array {
  if (code === undefined) return new Uint8Array();
  const text = encoder.encode(reason);
  const out = new Uint8Array(2 + text.length);
  new DataView(out.buffer).setUint16(0, code);
  out.set(text, 2);
  return out;
}

export function parseClosePayload(payload: Uint8Array): { code: number; reason: string } {
  if (payload.length < 2) return { code: 1005, reason: "" };
  const code = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint16(0);
  return { code, reason: decoder.decode(payload.subarray(2)) };
}

function concat(first: Uint8Array, second: Uint8Array): Uint8Array {
  if (first.length === 0) return second;
  const out = new Uint8Array(first.length + second.length);
  out.set(first);
  out.set(second, first.length);
  return out;
}

interface Header {
  readonly fin: boolean;
  readonly opcode: number;
  readonly masked: boolean;
  readonly headerLength: number;
  readonly payloadLength: number;
}

const EXTENDED_LENGTH_BYTES: readonly number[] = [2, 8];

function readPayloadLength(bytes: Uint8Array, short: number): number {
  if (short < 126) return short;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (short === 126) return view.getUint16(2);
  return Number(view.getBigUint64(2));
}

function readHeader(bytes: Uint8Array): Header | undefined {
  const first = bytes[0];
  const second = bytes[1];
  if (first === undefined || second === undefined) return undefined;
  const short = second & 0x7f;
  const extended = EXTENDED_LENGTH_BYTES[short - 126] ?? 0;
  if (bytes.length < 2 + extended) return undefined;
  const masked = (second & 0x80) !== 0;
  return {
    fin: (first & 0x80) !== 0,
    opcode: first & 0x0f,
    masked,
    headerLength: 2 + extended + (masked ? 4 : 0),
    payloadLength: readPayloadLength(bytes, short),
  };
}

function readPayload(bytes: Uint8Array, header: Header): Uint8Array {
  const payload = bytes.slice(header.headerLength, header.headerLength + header.payloadLength);
  if (!header.masked) return payload;
  const mask = bytes.subarray(header.headerLength - 4, header.headerLength);
  for (let at = 0; at < payload.length; at++) payload[at] = (payload[at] ?? 0) ^ (mask[at & 3] ?? 0);
  return payload;
}

/** Turns a byte stream that arrives in arbitrary pieces back into frames. */
export class FrameDecoder {
  private pending: Uint8Array = new Uint8Array();

  push(bytes: Uint8Array): Frame[] {
    this.pending = concat(this.pending, bytes);
    const frames: Frame[] = [];
    for (;;) {
      const header = readHeader(this.pending);
      if (!header || this.pending.length < header.headerLength + header.payloadLength) return frames;
      frames.push({ fin: header.fin, opcode: header.opcode, payload: readPayload(this.pending, header) });
      this.pending = this.pending.subarray(header.headerLength + header.payloadLength);
    }
  }
}

/** Joins a fragmented message's payloads. */
export function joinPayloads(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
