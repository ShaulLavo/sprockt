import { expect, test } from "bun:test";
import type { PreviewBackend } from "./transport";
import { createTunnels, NO_SERVER, REVOKED } from "./tunnels";

type PageSink = Parameters<PreviewBackend["connect"]>[1];
type ServerSink = Parameters<PreviewBackend["connect"]>[1];
type ResponseSink = Parameters<PreviewBackend["request"]>[2];
type Asked = Parameters<PreviewBackend["request"]>[1];

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (chunk: Uint8Array) => new TextDecoder().decode(chunk);
/** Lets queued work run: the authorization is asked, answered, and the batch passed on. */
const settle = async () => {
  for (let turn = 0; turn < 20; turn++) {
    // oxlint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
};
const GET: Asked = { method: "GET", target: "/events", headers: [], body: null };

/** A server that records what reaches it and lets the test speak for it. */
function server() {
  const state = {
    connections: 0,
    requests: 0,
    written: [] as string[],
    closed: 0,
    sinks: [] as ServerSink[],
    responses: [] as ResponseSink[],
    accepts: true,
  };
  const backend: PreviewBackend = {
    connect(_port, sink) {
      if (!state.accepts) return null;
      state.connections++;
      state.sinks.push(sink);
      return {
        write: (chunk) => void state.written.push(text(chunk)),
        close: () => void state.closed++,
      };
    },
    request(_port, _request, sink) {
      if (!state.accepts) return false;
      state.requests++;
      state.responses.push(sink);
      return true;
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

/** The page's end of an HTTP response. */
function reader() {
  const seen = { heads: 0, data: [] as string[], ended: 0, errors: [] as string[] };
  const sink: ResponseSink = {
    head: () => void seen.heads++,
    data: (chunk) => void seen.data.push(text(chunk)),
    end: () => void seen.ended++,
    error: (message) => void seen.errors.push(message),
  };
  return { seen, sink };
}

/**
 * The deploy, as the test sets it: yes or no, how often it was asked, and, when `held` is set,
 * a question that stays out until the test answers it.
 */
function deploy(initial = true) {
  const world = {
    says: initial,
    asked: 0,
    held: undefined as PromiseWithResolvers<void> | undefined,
  };
  const authorized = async (): Promise<boolean> => {
    world.asked++;
    // The answer is what the deploy said when it was asked, not when the answer came.
    const said = world.says;
    await world.held?.promise;
    return said;
  };
  return { world, authorized };
}

/** A socket through the tunnels whose connection the deploy has allowed. */
async function openSocket(tunnels: ReturnType<typeof createTunnels>, backend: PreviewBackend) {
  const browser = page();
  const connection = tunnels.guard(backend).connect(3000, browser.sink);
  if (!connection) throw new Error("The tunnels always take a socket");
  await settle();
  return { browser, connection };
}

test("a socket reaches the server only on a yes, and so does every frame after it", async () => {
  const { world, authorized } = deploy();
  const { state, backend } = server();
  const tunnels = createTunnels(authorized);
  const browser = page();
  const connection = tunnels.guard(backend).connect(3000, browser.sink);
  expect(tunnels.live).toBe(1);
  expect(state.connections).toBe(0);
  await settle();
  expect(state.connections).toBe(1);
  expect(world.asked).toBe(1);

  connection?.write(bytes("ping"));
  await settle();
  expect(state.written).toEqual(["ping"]);
  expect(world.asked).toBe(2);

  await state.sinks[0]?.data(bytes("pong"));
  expect(browser.seen.data).toEqual(["pong"]);
  // A new frame, a new question: the earlier yes is not used again.
  expect(world.asked).toBe(3);
});

test("frames that wait together share one question and keep their order", async () => {
  const { world, authorized } = deploy();
  const { state, backend } = server();
  const { connection } = await openSocket(createTunnels(authorized), backend);
  world.asked = 0;
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
  const { browser, connection } = await openSocket(tunnels, backend);
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
  const { browser } = await openSocket(createTunnels(authorized), backend);
  world.says = false;
  await state.sinks[0]?.data(bytes("hot update"));
  expect(browser.seen.data).toEqual([]);
  expect(browser.seen.ended).toBe(1);
  expect(state.closed).toBe(1);
});

test("one no ends every live stream, not only the one that asked", async () => {
  const { world, authorized } = deploy();
  const { state, backend } = server();
  const tunnels = createTunnels(authorized);
  const first = await openSocket(tunnels, backend);
  const second = await openSocket(tunnels, backend);
  const response = reader();
  tunnels.guard(backend).request(3000, GET, response.sink);
  await settle();
  expect(tunnels.live).toBe(3);

  world.says = false;
  first.connection.write(bytes("x"));
  await settle();
  // The idle socket and the open response were allowed by an answer that no longer holds.
  expect(first.browser.seen.ended).toBe(1);
  expect(second.browser.seen.ended).toBe(1);
  expect(response.seen.errors).toEqual([REVOKED]);
  expect(state.closed).toBe(2);
  expect(tunnels.live).toBe(0);
});

test("revoke ends idle sockets at once, without waiting for a frame", async () => {
  const { world, authorized } = deploy();
  const { state, backend } = server();
  const tunnels = createTunnels(authorized);
  const { browser } = await openSocket(tunnels, backend);
  world.asked = 0;
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
  const { browser, connection } = await openSocket(tunnels, backend);
  // The server answers, then hangs up, all at once.
  void state.sinks[0]?.data(bytes("last words"));
  state.sinks[0]?.end();
  await settle();
  expect(browser.seen.data).toEqual(["last words"]);
  expect(browser.seen.ended).toBe(1);
  expect(tunnels.live).toBe(0);
  // The page closing afterwards closes nothing twice.
  connection.close();
  await settle();
  expect(state.closed).toBe(0);
});

test("a page that closes its socket lets go of the server's connection at once, whatever waits for an answer", async () => {
  const { world, authorized } = deploy();
  const { state, backend } = server();
  const tunnels = createTunnels(authorized);
  const { browser, connection } = await openSocket(tunnels, backend);

  // The deploy is slow to answer: a frame waits for it.
  world.held = Promise.withResolvers<void>();
  connection.write(bytes("bye"));
  await settle();
  connection.close();
  // Not after the question: now.
  expect(state.closed).toBe(1);
  expect(tunnels.live).toBe(0);
  // The page closed it, so the page is not told that it ended.
  expect(browser.seen.ended).toBe(0);

  // The answer that comes later passes nothing on.
  world.held.resolve();
  await settle();
  expect(state.written).toEqual([]);
  expect(state.closed).toBe(1);
});

test("a page that closes a socket still waiting for its first yes leaves the server untouched", async () => {
  const { world, authorized } = deploy();
  const { state, backend } = server();
  const tunnels = createTunnels(authorized);
  world.held = Promise.withResolvers<void>();
  const connection = tunnels.guard(backend).connect(3000, page().sink);
  connection?.close();
  expect(tunnels.live).toBe(0);
  world.held.resolve();
  await settle();
  expect(state.connections).toBe(0);
  expect(state.closed).toBe(0);
});

test("a server that is gone by the yes is told to the page as no server", async () => {
  const { authorized } = deploy();
  const { state, backend } = server();
  state.accepts = false;
  const tunnels = createTunnels(authorized);
  const { browser } = await openSocket(tunnels, backend);
  expect(browser.seen.errors).toEqual([NO_SERVER]);
  const response = reader();
  expect(tunnels.guard(backend).request(3000, GET, response.sink)).toBe(true);
  await settle();
  expect(response.seen.errors).toEqual([NO_SERVER]);
  expect(tunnels.live).toBe(0);
});

test("a handoff that arrives once the deploy said no never reaches the server", async () => {
  const { world, authorized } = deploy(false);
  const { state, backend } = server();
  const tunnels = createTunnels(authorized);
  const socket = await openSocket(tunnels, backend);
  const response = reader();
  tunnels.guard(backend).request(3000, GET, response.sink);
  await settle();
  expect(state.connections).toBe(0);
  expect(state.requests).toBe(0);
  expect(socket.browser.seen.ended).toBe(1);
  expect(response.seen.errors).toEqual([REVOKED]);
  expect(world.asked).toBeGreaterThan(0);
  expect(tunnels.live).toBe(0);
});

test("a handoff whose question was out when previews were revoked is refused, even on a yes", async () => {
  const { world, authorized } = deploy();
  const { state, backend } = server();
  const tunnels = createTunnels(authorized);
  world.held = Promise.withResolvers<void>();
  const socket = page();
  tunnels.guard(backend).connect(3000, socket.sink);
  const response = reader();
  tunnels.guard(backend).request(3000, GET, response.sink);
  await settle();

  // The worker says previews are off while the deploy is being asked. Its answer, a yes, was
  // asked before that, and it does not let either handoff through.
  tunnels.revoke();
  world.held.resolve();
  await settle();
  expect(state.connections).toBe(0);
  expect(state.requests).toBe(0);
  expect(socket.seen.ended).toBe(1);
  expect(response.seen.errors).toEqual([REVOKED]);
  expect(tunnels.live).toBe(0);
});

test("a request reaches the server only on a yes, and the head and every chunk wait for their own", async () => {
  const { world, authorized } = deploy();
  const { state, backend } = server();
  const tunnels = createTunnels(authorized);
  const response = reader();
  expect(tunnels.guard(backend).request(3000, GET, response.sink)).toBe(true);
  expect(state.requests).toBe(0);
  await settle();
  expect(state.requests).toBe(1);
  expect(world.asked).toBe(1);

  const stream = state.responses[0];
  stream?.head({ status: 200, statusText: "OK", headers: [] });
  await stream?.data(new Uint8Array(bytes("first")));
  expect(response.seen.heads).toBe(1);
  expect(response.seen.data).toEqual(["first"]);
  const asked = world.asked;
  expect(asked).toBeGreaterThan(1);

  // A server-sent event after the deploy changed: no fresh yes, so it never reaches the page.
  world.says = false;
  await stream?.data(new Uint8Array(bytes("after the change")));
  expect(response.seen.data).toEqual(["first"]);
  expect(response.seen.errors).toEqual([REVOKED]);
  expect(world.asked).toBe(asked + 1);
  expect(tunnels.live).toBe(0);

  // The server goes on sending; none of it reaches the page.
  world.says = true;
  await stream?.data(new Uint8Array(bytes("later")));
  stream?.end();
  await settle();
  expect(response.seen.data).toEqual(["first"]);
  expect(response.seen.ended).toBe(0);
});

test("a chunk held back by a slow answer is not delivered when previews are revoked meanwhile", async () => {
  const { world, authorized } = deploy();
  const { state, backend } = server();
  const tunnels = createTunnels(authorized);
  const response = reader();
  tunnels.guard(backend).request(3000, GET, response.sink);
  await settle();
  const stream = state.responses[0];
  world.held = Promise.withResolvers<void>();
  const delivered = stream?.data(new Uint8Array(bytes("held")));
  await settle();
  tunnels.revoke();
  expect(response.seen.errors).toEqual([REVOKED]);
  world.held.resolve();
  // The server's wait for the chunk ends: it is not left hanging on a stream that is gone.
  await delivered;
  expect(response.seen.data).toEqual([]);
});

test("a response that finished is forgotten, and revoking later does not touch it", async () => {
  const { authorized } = deploy();
  const { state, backend } = server();
  const tunnels = createTunnels(authorized);
  const response = reader();
  tunnels.guard(backend).request(3000, GET, response.sink);
  await settle();
  state.responses[0]?.end();
  await settle();
  expect(tunnels.live).toBe(0);
  tunnels.revoke();
  expect(response.seen.ended).toBe(1);
  expect(response.seen.errors).toEqual([]);
});
