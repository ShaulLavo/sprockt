// Live connections of mounted previews, under an authorization that can be taken back.
//
// The service worker asks the deploy before it hands a request or a socket to this tab
// (retirement.ts). From then on the bytes flow between this tab and the page without it, and a
// handoff can arrive late, after the deploy changed. So the tab keeps the authorization itself.
// Every server it registers is wrapped here, and the wrapper is one rule for sockets and HTTP
// responses alike:
//
// - nothing is passed on without a yes from the deploy that was asked after it arrived
//   (fresh.ts): not the handoff itself (the server sees no request and no connection before
//   that yes), not a frame of a socket in either direction, not a head or a chunk of a
//   response. What waits together shares one question;
// - when the answer is no, or the deploy cannot be asked, every live stream is ended: a socket
//   on both sides (the server's connection is closed, the page told the stream ended), a
//   response with an error to the page;
// - `revoke` does the same at once, for when the worker or a newer build's page says previews
//   are off, without waiting for the next frame. A stream whose question was out when that
//   happened is ended too: its answer was asked before the revocation.
// - a page that closes its socket lets go of the server's connection at once, whatever is
//   still waiting for an answer.
//
// One limit, Waffle's: a response that is cut off stops reaching the page, but the server's
// side of it is not closed, because Waffle's `PreviewServer.request()` gives no way to cancel
// one request (ARCHITECTURE.md, Known gaps).
//
// This uses nothing but the server interface Waffle's router already talks to: a server may end
// a connection whenever it likes, and here the wrapper is the server.
import type { PreviewBackend } from "./transport";

type PageSink = Parameters<PreviewBackend["connect"]>[1];
type Connection = NonNullable<ReturnType<PreviewBackend["connect"]>>;
type ResponseSink = Parameters<PreviewBackend["request"]>[2];
type Asked = Parameters<PreviewBackend["request"]>[1];

/** One thing to pass on, and the word to whoever waits for it: it ran, or it never will. */
interface Step {
  readonly run: () => void | Promise<void>;
  readonly settled: () => void;
}

export interface Tunnels {
  /** The same server, with its connections and responses under this authorization. */
  guard(backend: PreviewBackend): PreviewBackend;
  /** Ends every live connection and cuts off every response, now. */
  revoke(): void;
  /** How many connections and responses are live, waiting for their first yes included. */
  readonly live: number;
}

/** What a response that is cut off is ended with; the page gets it as a failed request. */
export const REVOKED = "preview revoked";
/** What the page gets when the server is gone by the time the deploy said yes. */
export const NO_SERVER = "no server";

/** One live connection or response: everything it passes on goes through here, in order. */
interface Stream {
  /** Queues one step. Resolves when it ran, or when the stream ended without it. */
  pass(run: Step["run"]): Promise<void>;
  /** The last step of a stream that ends by itself, after everything queued before it. */
  finish(last: () => void): void;
  /** Ends the stream now, dropping what waits, with `last` instead of the cut. */
  close(last: () => void): void;
}

const settle = (steps: readonly Step[]): void => {
  for (const step of steps) step.settled();
};

/** `authorized`: whether the deploy, asked now, says mounted previews may be served. Never rejects. */
export function createTunnels(authorized: () => Promise<boolean>): Tunnels {
  /** One function per live stream: it cuts that one off. */
  const live = new Set<() => void>();

  function revoke(): void {
    for (const cut of Array.from(live)) cut();
  }

  /** `cut`: how this stream is ended when the deploy takes its word back. */
  function openStream(cut: () => void): Stream {
    let open = true;
    let draining = false;
    const queue: Step[] = [];
    /** Read through a function where a loop awaits: the stream can end in between. */
    const isOpen = (): boolean => open;

    /** Marks the stream ended and drops what waits. False when it had ended already. */
    function stop(): boolean {
      if (!open) return false;
      open = false;
      live.delete(revokeThis);
      settle(queue.splice(0));
      return true;
    }
    function revokeThis(): void {
      if (stop()) cut();
    }
    live.add(revokeThis);

    /** In the order the steps came; each may wait for the one before to be taken. */
    async function passOn(batch: readonly Step[]): Promise<void> {
      for (const step of batch) {
        if (!isOpen()) return;
        // oxlint-disable-next-line no-await-in-loop
        await step.run();
      }
    }

    /** One batch: passed on only on a yes that was asked after every step in it arrived. */
    async function passBatch(batch: readonly Step[]): Promise<void> {
      try {
        // A revocation while the question was out has ended this stream, and `passOn` sees it.
        if (await authorized()) return await passOn(batch);
        // Not this stream alone: whatever else is live was allowed by an older answer.
        revoke();
      } finally {
        settle(batch);
      }
    }

    async function drain(): Promise<void> {
      if (draining) return;
      draining = true;
      try {
        // One batch after the other: a batch is what queued up while the one before was asked for.
        // oxlint-disable-next-line no-await-in-loop
        while (isOpen() && queue.length > 0) await passBatch(queue.splice(0));
      } catch (error) {
        // Nothing is passed on after a failure.
        console.error("A preview connection failed while passing data on", error);
        revokeThis();
      } finally {
        draining = false;
        if (!open) settle(queue.splice(0));
      }
    }

    function pass(run: Step["run"]): Promise<void> {
      if (!open) return Promise.resolve();
      const ran = Promise.withResolvers<void>();
      queue.push({ run, settled: ran.resolve });
      void drain();
      return ran.promise;
    }

    return {
      pass,
      finish: (last) =>
        void pass(() => {
          if (stop()) last();
        }),
      close: (last) => {
        if (stop()) last();
      },
    };
  }

  function connect(backend: PreviewBackend, port: number, page: PageSink): Connection {
    let server: Connection | null = null;
    const stream = openStream(() => {
      server?.close();
      page.end();
    });
    // The handoff is a step like any other: the server sees the connection only after a yes.
    void stream.pass(() => {
      server = backend.connect(port, {
        data: (bytes) => stream.pass(() => page.data(bytes)),
        end: () => stream.finish(() => page.end()),
        error: (message) => stream.finish(() => page.error(message)),
      });
      if (!server) stream.close(() => page.error(NO_SERVER));
    });
    return {
      write: (bytes) => void stream.pass(() => server?.write(bytes)),
      // The page is gone: the server's connection goes now, not after a pending question.
      close: () => stream.close(() => server?.close()),
    };
  }

  function request(backend: PreviewBackend, port: number, asked: Asked, page: ResponseSink): boolean {
    const stream = openStream(() => page.error(REVOKED));
    // The server sees the request only after a yes, and the page gets nothing of the response
    // without one: the head and every chunk wait for their own.
    void stream.pass(() => {
      const accepted = backend.request(port, asked, {
        head: (head) => void stream.pass(() => page.head(head)),
        data: (chunk) => stream.pass(() => page.data(chunk)),
        end: () => stream.finish(() => page.end()),
        error: (message) => stream.finish(() => page.error(message)),
      });
      if (!accepted) stream.close(() => page.error(NO_SERVER));
    });
    // Taken: whether it is served is the deploy's word, and the page hears it either way.
    return true;
  }

  return {
    guard: (backend) => ({
      connect: (port, page) => connect(backend, port, page),
      request: (port, asked, page) => request(backend, port, asked, page),
    }),
    revoke,
    get live() {
      return live.size;
    },
  };
}
