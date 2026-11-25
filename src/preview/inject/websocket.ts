// A WebSocket for previewed pages. The dev server lives inside the workspace, so there is no
// real socket to open: the service worker hands us a byte channel to the server and this class
// speaks the WebSocket protocol over it. Sockets to anywhere else stay native.
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
  type Frame,
} from "../websocket-frames";

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;
/** How long a closing socket waits for the server's close frame before it gives up. */
const CLOSE_WAIT_MS = 3000;

export interface TunnelTarget {
  /** The port of the server inside the workspace. */
  readonly port: number;
  /** Path and query on that server. */
  readonly target: string;
  /** The URL the page asked for, as `ws:` or `wss:`. */
  readonly url: string;
}

type Sendable = string | ArrayBufferLike | ArrayBufferView | Blob;
type Handler<E extends Event> = ((this: WebSocket, event: E) => unknown) | null;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const concat = (first: Uint8Array, second: Uint8Array) => joinPayloads([first, second]);

function toBytes(data: Exclude<Sendable, Blob>): Uint8Array {
  if (typeof data === "string") return encoder.encode(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
  return new Uint8Array(data).slice();
}

/**
 * Hands the far end of a socket's channel to whatever reaches the server on `port`. False when
 * nothing can, and the socket then fails as a refused connection does.
 */
export type TunnelConnect = (far: MessagePort, port: number) => boolean;

/** The way a previewed page reaches its server: through the service worker that serves it. */
const throughServiceWorker: TunnelConnect = (far, port) => {
  const controller = navigator.serviceWorker?.controller;
  if (!controller) return false;
  controller.postMessage({ type: "preview-socket", port }, [far]);
  return true;
};

/** Sockets of this document that are not closed yet. */
const live = new Set<TunnelWebSocket>();

/**
 * Ends every socket of this document, for when the document goes away. The server learns that a
 * socket is gone only from its channel's `end` message; a page that was reloaded or removed
 * without sending it would leave the connection open on the server for good.
 */
export function endTunnels(): void {
  for (const socket of Array.from(live)) socket.abandon();
}

export class TunnelWebSocket extends EventTarget {
  static readonly CONNECTING = CONNECTING;
  static readonly OPEN = OPEN;
  static readonly CLOSING = CLOSING;
  static readonly CLOSED = CLOSED;
  readonly CONNECTING = CONNECTING;
  readonly OPEN = OPEN;
  readonly CLOSING = CLOSING;
  readonly CLOSED = CLOSED;

  readonly url: string;
  readonly extensions = "";
  protocol = "";
  readyState = CONNECTING;
  bufferedAmount = 0;
  binaryType: BinaryType = "blob";
  onopen: Handler<Event> = null;
  onmessage: Handler<MessageEvent> = null;
  onerror: Handler<Event> = null;
  onclose: Handler<CloseEvent> = null;

  private readonly channel = new MessageChannel();
  private readonly frames = new FrameDecoder();
  private readonly key = handshakeKey();
  private readonly protocols: readonly string[];
  private handshake: Uint8Array | undefined = new Uint8Array();
  /**
   * Bytes that arrived after the handshake's answer, while that answer is being checked. They
   * are frames, and they wait here so that none is read before the socket is open or ahead of
   * an earlier one. Undefined at every other time.
   */
  private early: Uint8Array[] | undefined;
  private fragments: Uint8Array[] = [];
  private fragmentOpcode = 0;
  private sends: Promise<void> = Promise.resolve();
  private closeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly tunnel: TunnelTarget,
    protocols: string | readonly string[] = [],
    connect: TunnelConnect = throughServiceWorker,
  ) {
    super();
    this.url = tunnel.url;
    this.protocols = typeof protocols === "string" ? [protocols] : protocols;
    this.channel.port1.addEventListener("message", (event: MessageEvent<unknown>) =>
      this.receive(event.data),
    );
    this.channel.port1.start();
    live.add(this);
    if (!connect(this.channel.port2, tunnel.port)) queueMicrotask(() => this.fail());
  }

  /** Closes the socket at once because its document is going away. */
  abandon(): void {
    this.finish(1001, "", false);
  }

  override dispatchEvent(event: Event): boolean {
    const handler: unknown = Reflect.get(this, `on${event.type}`);
    if (typeof handler === "function") Reflect.apply(handler, this, [event]);
    return super.dispatchEvent(event);
  }

  send(data: Sendable): void {
    if (this.readyState === CONNECTING)
      throw new DOMException("The socket is still connecting", "InvalidStateError");
    if (this.readyState !== OPEN) return;
    if (data instanceof Blob) {
      this.sends = this.sends.then(async () =>
        this.write(OPCODE.binary, new Uint8Array(await data.arrayBuffer())),
      );
      return;
    }
    const opcode = typeof data === "string" ? OPCODE.text : OPCODE.binary;
    const bytes = toBytes(data);
    this.sends = this.sends.then(() => this.write(opcode, bytes));
  }

  close(code?: number, reason = ""): void {
    if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) {
      throw new DOMException("Invalid WebSocket close code", "InvalidAccessError");
    }
    if (this.readyState === CLOSING || this.readyState === CLOSED) return;
    if (this.readyState === CONNECTING) return this.finish(1006, "", false);
    this.readyState = CLOSING;
    this.sends = this.sends.then(() => this.write(OPCODE.close, closePayload(code, reason)));
    this.closeTimer = setTimeout(() => this.finish(code ?? 1005, reason, true), CLOSE_WAIT_MS);
  }

  private write(opcode: number, payload: Uint8Array): void {
    if (this.readyState === CLOSED) return;
    const frame = encodeFrame(opcode, payload, crypto.getRandomValues(new Uint8Array(4)));
    this.channel.port1.postMessage({ type: "data", chunk: frame }, [frame.buffer]);
  }

  private receive(message: unknown): void {
    if (!message || typeof message !== "object" || !("type" in message)) return;
    if (message.type === "accepted") return this.startHandshake();
    if (message.type === "data" && "chunk" in message && message.chunk instanceof Uint8Array)
      return this.data(message.chunk);
    if (message.type === "end") return this.finish(1006, "", false);
    if (message.type === "error") this.fail();
  }

  private startHandshake(): void {
    const { target, port } = this.tunnel;
    const request = handshakeRequest({
      target,
      host: `localhost:${port}`,
      key: this.key,
      protocols: this.protocols,
    });
    this.channel.port1.postMessage({ type: "data", chunk: request }, [request.buffer]);
  }

  private data(chunk: Uint8Array): void {
    if (this.early) return void this.early.push(chunk);
    if (this.handshake === undefined) return this.handleFrames(chunk);
    this.handshake = concat(this.handshake, chunk);
    const response = parseHandshakeResponse(this.handshake);
    if (!response) return;
    this.handshake = undefined;
    // Checking the answer takes a moment (a digest). What follows it waits in `early`.
    this.early = [response.rest];
    void this.accept(response.status, response.headers);
  }

  private async accept(status: number, headers: ReadonlyMap<string, string>): Promise<void> {
    const expected = await acceptFor(this.key);
    const waiting = this.early ?? [];
    this.early = undefined;
    if (status !== 101 || headers.get("sec-websocket-accept") !== expected) return this.fail();
    if (this.readyState !== CONNECTING) return;
    this.protocol = headers.get("sec-websocket-protocol") ?? "";
    this.readyState = OPEN;
    this.dispatchEvent(new Event("open"));
    // Open first, then the frames in the order they arrived.
    for (const chunk of waiting) this.handleFrames(chunk);
  }

  private handleFrames(chunk: Uint8Array): void {
    for (const frame of this.frames.push(chunk)) this.handleFrame(frame);
  }

  private handleFrame(frame: Frame): void {
    if (this.readyState === CLOSED) return;
    if (frame.opcode === OPCODE.ping) return this.write(OPCODE.pong, frame.payload);
    if (frame.opcode === OPCODE.pong) return;
    if (frame.opcode === OPCODE.close) return this.closedByServer(frame.payload);
    if (frame.opcode !== OPCODE.continuation) this.fragmentOpcode = frame.opcode;
    this.fragments.push(frame.payload);
    if (!frame.fin) return;
    const payload = this.fragments.length === 1 ? frame.payload : joinPayloads(this.fragments);
    this.fragments = [];
    this.deliver(this.fragmentOpcode, payload);
  }

  private deliver(opcode: number, payload: Uint8Array): void {
    if (opcode === OPCODE.text) {
      this.dispatchEvent(new MessageEvent("message", { data: decoder.decode(payload) }));
      return;
    }
    const copy = new Uint8Array(payload);
    const data = this.binaryType === "blob" ? new Blob([copy]) : copy.buffer;
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  private closedByServer(payload: Uint8Array): void {
    const { code, reason } = parseClosePayload(payload);
    // A close we did not start is echoed back, as the protocol asks.
    if (this.readyState === OPEN) this.write(OPCODE.close, payload);
    this.finish(code, reason, true);
  }

  private fail(): void {
    if (this.readyState === CLOSED) return;
    this.dispatchEvent(new Event("error"));
    this.finish(1006, "", false);
  }

  private finish(code: number, reason: string, wasClean: boolean): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    live.delete(this);
    this.early = undefined;
    clearTimeout(this.closeTimer);
    this.channel.port1.postMessage({ type: "end" });
    this.channel.port1.close();
    this.dispatchEvent(new CloseEvent("close", { code, reason, wasClean }));
  }
}
