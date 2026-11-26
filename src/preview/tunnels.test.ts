import { expect, test } from "bun:test";
import type { PreviewBackend } from "./transport";
import { createTunnels, REVOKED } from "./tunnels";

type PageSink = Parameters<PreviewBackend["connect"]>[1];
type ServerSink = Parameters<PreviewBackend["connect"]>[1];
type ResponseSink = Parameters<PreviewBackend["request"]>[2];

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (chunk: Uint8Array) => new TextDecoder().decode(chunk);
/** Lets queued work run: the authorization is asked, answered, and the batch passed on. */
const settle = async () => {
  for (let turn = 0; turn < 20; turn++) {
    // oxlint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
};

/** A server that records what reaches it and lets the test speak for it. */
function server() {
  const state = {
    written: [] as string[],
    closed: 0,
    sinks: [] as ServerSink[],
    responses: [] as ResponseSink[],
    accepts: true,
  };
  const backend: PreviewBackend = {
    connect(_port, sink) {
      if (!state.accepts) return null;
      state.sinks.push(sink);
      return {
        write: (chunk) => void state.written.push(text(chunk)),
        close: () => void state.closed++,
      };
    },
    request(_port, _request, sink) {
      state.responses.push(sink);
      return state.accepts;
    },
  };
  return { state, backend };
}

/** The page's end of a socket, as Waffle's router gives it to a server. */
function page() {
  const seen = { data: [] as string[], ended: 0, errors: [] as string[] };
  const sink: PageSink = {
    data: (chunk) => void seen.data.push(text(chunk)),
    end: () => void seen.ended++,
    error: (message) => void seen.errors.push(message),
  };
  return { seen, sink };
}

/** The deploy, as the test sets it: yes, no, and how often it was asked. */
function deploy(initial = true) {
  const world = { says: initial, asked: 0 };
  const authorized = async (): Promise<boolean> => {
    world.asked++;
    return world.says;
  };
  return { world, authorized };
}

test("frames pass both ways while the deploy says yes, each on an answer asked after it came", async () => {
  const { world, authorized } = deploy();
  const { state, backend } = server();
  const tunnels = createTunnels(authorized);
  const browser = page();
  const connection = tunnels.guard(backend).connect(3000, browser.sink);
  expect(connection).not.toBeNull();
  expect(tunnels.live).toBe(1);
  // Nothing was asked for a socket that carries nothing yet.
  expect(world.asked).toBe(0);

  connection?.write(bytes("ping"));
  await settle();
  expect(state.written).toEqual(["ping"]);
  expect(world.asked).toBe(1);

  await state.sinks[0]?.data(bytes("pong"));
  expect(browser.seen.data).toEqual(["pong"]);
  // A new frame, a new question: the earlier yes is not used again.
  expect(world.asked).toBe(2);
});

test("frames that wait together share one question and keep their order", async () => {
  const { world, authorized } = deploy();
  const { state, backend } = server();
  const connection = createTunnels(authorized).guard(backend).connect(3000, page().sink);
  for (const frame of ["a", "b", "c", "d", "e"]) connection?.write(bytes(frame));
  await settle();
  expect(state.written).toEqual(["a", "b", "c", "d", "e"]);
  // One question for the first frame, and one that the four behind it share: they came while
  // the first was being asked for, so its answer is not theirs.
  expect(world.asked).toBe(2);
});

test("a socket that was open when previews went away is ended on both sides, and carries nothing more", async () => {
  const { world, authorized } = deploy();
  const { state, backend } = server();
  const tunnels = createTunnels(authorized);
  const browser = page();
  const connection = tunnels.guard(backend).connect(3000, browser.sink);
  connection?.write(bytes("before"));
  await settle();
  expect(state.written).toEqual(["before"]);

  // The deploy changes, or cannot be asked any more: the answer is no longer yes.
  world.says = false;
  connection?.write(bytes("secret from the page"));
  await settle();
  expect(state.written).toEqual(["before"]);
  expect(state.closed).toBe(1);
  expect(browser.seen.ended).toBe(1);
  expect(tunnels.live).toBe(0);

  // Whatever either side still sends goes nowhere, even if the deploy says yes again.
  world.says = true;
  connection?.write(bytes("later"));
  await state.sinks[0]?.data(bytes("secret from the server"));
  await settle();
  expect(state.written).toEqual(["before"]);
  expect(browser.seen.data).toEqual([]);
  expect(state.closed).toBe(1);
  expect(browser.seen.ended).toBe(1);
});

test("a frame from the server is held back the same way", async () => {
  const { world, authorized } = deploy();
  const { state, backend } = server();
  const browser = page();
  createTunnels(authorized).guard(backend).connect(3000, browser.sink);
  world.says = false;
  await state.sinks[0]?.data(bytes("hot update"));
  expect(browser.seen.data).toEqual([]);
  expect(browser.seen.ended).toBe(1);
  expect(state.closed).toBe(1);
});

test("one no ends every live socket, not only the one that asked", async () => {
  const { world, authorized } = deploy();
  const { state, backend } = server();
  const tunnels = createTunnels(authorized);
  const guarded = tunnels.guard(backend);
  const first = page();
  const second = page();
  const busy = guarded.connect(3000, first.sink);
  guarded.connect(3000, second.sink);
  expect(tunnels.live).toBe(2);

  world.says = false;
  busy?.write(bytes("x"));
  await settle();
  // The idle socket was allowed by an answer that no longer holds, so it goes too.
  expect(first.seen.ended).toBe(1);
  expect(second.seen.ended).toBe(1);
  expect(state.closed).toBe(2);
  expect(tunnels.live).toBe(0);
});

test("revoke ends idle sockets at once, without waiting for a frame", async () => {
  const { world, authorized } = deploy();
  const { state, backend } = server();
  const tunnels = createTunnels(authorized);
  const browser = page();
  tunnels.guard(backend).connect(3000, browser.sink);
  tunnels.revoke();
  expect(browser.seen.ended).toBe(1);
  expect(state.closed).toBe(1);
  expect(tunnels.live).toBe(0);
  expect(world.asked).toBe(0);
  // Twice is the same as once.
  tunnels.revoke();
  expect(browser.seen.ended).toBe(1);
});

test("a socket that ends by itself is forgotten, after what was queued before the end", async () => {
  const { authorized } = deploy();
  const { state, backend } = server();
  const tunnels = createTunnels(authorized);
  const browser = page();
  const connection = tunnels.guard(backend).connect(3000, browser.sink);
  // The server answers, then hangs up, all at once.
  void state.sinks[0]?.data(bytes("last words"));
  state.sinks[0]?.end();
  await settle();
  expect(browser.seen.data).toEqual(["last words"]);
  expect(browser.seen.ended).toBe(1);
  expect(tunnels.live).toBe(0);
  // The page closing afterwards closes nothing twice.
  connection?.close();
  await settle();
  expect(state.closed).toBe(0);

  // And the page's own close reaches the server.
  const other = tunnels.guard(backend).connect(3000, page().sink);
  other?.write(bytes("bye"));
  other?.close();
  await settle();
  expect(state.written).toEqual(["bye"]);
  expect(state.closed).toBe(1);
  expect(tunnels.live).toBe(0);
});

test("a server that takes no connection has none to guard", () => {
  const { authorized } = deploy();
  const { state, backend } = server();
  state.accepts = false;
  const tunnels = createTunnels(authorized);
  expect(tunnels.guard(backend).connect(3000, page().sink)).toBeNull();
  expect(tunnels.live).toBe(0);
});

test("a response that is still streaming is cut off when previews are revoked", () => {
  const { authorized } = deploy();
  const { state, backend } = server();
  const tunnels = createTunnels(authorized);
  const seen = { heads: 0, data: [] as string[], ended: 0, errors: [] as string[] };
  const sink: ResponseSink = {
    head: () => void seen.heads++,
    data: (chunk) => void seen.data.push(text(chunk)),
    end: () => void seen.ended++,
    error: (message) => void seen.errors.push(message),
  };
  const request = { method: "GET", target: "/events", headers: [], body: null };
  expect(tunnels.guard(backend).request(3000, request, sink)).toBe(true);
  const stream = state.responses[0];
  stream?.head({ status: 200, statusText: "OK", headers: [] });
  void stream?.data(new Uint8Array(bytes("first")));
  expect(seen.data).toEqual(["first"]);
  expect(tunnels.live).toBe(1);

  tunnels.revoke();
  expect(seen.errors).toEqual([REVOKED]);
  expect(tunnels.live).toBe(0);
  // The server goes on sending; none of it reaches the page.
  void stream?.data(new Uint8Array(bytes("second")));
  stream?.end();
  expect(seen.data).toEqual(["first"]);
  expect(seen.ended).toBe(0);
});

test("a response that finished is forgotten, and revoking later does not touch it", () => {
  const { authorized } = deploy();
  const { state, backend } = server();
  const tunnels = createTunnels(authorized);
  const seen = { ended: 0, errors: [] as string[] };
  const sink: ResponseSink = {
    head: () => {},
    data: () => {},
    end: () => void seen.ended++,
    error: (message) => void seen.errors.push(message),
  };
  tunnels.guard(backend).request(3000, { method: "GET", target: "/", headers: [], body: null }, sink);
  state.responses[0]?.end();
  expect(tunnels.live).toBe(0);
  tunnels.revoke();
  expect(seen).toEqual({ ended: 1, errors: [] });
});
