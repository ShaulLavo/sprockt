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
  private fragments: Uint8Array[] = [];
  private fragmentOpcode = 0;
  private sends: Promise<void> = Promise.resolve();
  private closeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly tunnel: TunnelTarget,
    protocols: string | readonly string[] = [],
  ) {
    super();
    this.url = tunnel.url;
    this.protocols = typeof protocols === "string" ? [protocols] : protocols;
    this.channel.port1.addEventListener("message", (event: MessageEvent<unknown>) =>
      this.receive(event.data),
    );
    this.channel.port1.start();
    const controller = navigator.serviceWorker?.controller;
    if (!controller) {
      queueMicrotask(() => this.fail());
      return;
    }
    controller.postMessage({ type: "preview-socket", port: tunnel.port }, [this.channel.port2]);
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
    if (this.handshake === undefined) return this.handleFrames(chunk);
    this.handshake = concat(this.handshake, chunk);
    const response = parseHandshakeResponse(this.handshake);
    if (!response) return;
    this.handshake = undefined;
    void this.accept(response.status, response.headers, response.rest);
  }

  private async accept(
    status: number,
    headers: ReadonlyMap<string, string>,
    rest: Uint8Array,
  ): Promise<void> {
    const expected = await acceptFor(this.key);
    if (status !== 101 || headers.get("sec-websocket-accept") !== expected) return this.fail();
    if (this.readyState !== CONNECTING) return;
    this.protocol = headers.get("sec-websocket-protocol") ?? "";
    this.readyState = OPEN;
    this.dispatchEvent(new Event("open"));
    if (rest.length > 0) this.handleFrames(rest);
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
    clearTimeout(this.closeTimer);
    this.channel.port1.postMessage({ type: "end" });
    this.channel.port1.close();
    this.dispatchEvent(new CloseEvent("close", { code, reason, wasClean }));
  }
}
