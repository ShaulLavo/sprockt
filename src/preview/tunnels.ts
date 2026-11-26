// Live connections of mounted previews, under an authorization that can be taken back.
//
// The service worker asks the deploy before it starts a request or a socket (retirement.ts).
// A WebSocket outlives that moment: the worker hands the page's port to the tab that runs the
// server, and from then on the bytes flow between that tab and the page without it. So the tab
// keeps the authorization itself. Every server it registers is wrapped here:
//
// - no frame of a socket is passed on, in either direction, without a yes from the deploy that
//   was asked after the frame arrived (fresh.ts). Frames that wait together share one question;
// - when the answer is no, or the deploy cannot be asked, every live socket is ended on both
//   sides (the server's connection is closed, the page is told the stream ended), and every
//   response still streaming is cut off;
// - `revoke` does the same at once, for when the worker or a newer build's page says previews
//   are off, without waiting for the next frame.
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
  /** Ends every live connection and cuts off every streaming response, now. */
  revoke(): void;
  /** How many connections and responses are live. */
  readonly live: number;
}

/** What a response that is cut off is ended with; the page gets it as a failed request. */
export const REVOKED = "preview revoked";

const settle = (steps: readonly Step[]): void => {
  for (const step of steps) step.settled();
};

/** `authorized`: whether the deploy, asked now, says mounted previews may be served. Never rejects. */
export function createTunnels(authorized: () => Promise<boolean>): Tunnels {
  /** One function per live connection or response: it ends that one. */
  const live = new Set<() => void>();

  function revoke(): void {
    for (const end of Array.from(live)) end();
  }

  function connect(backend: PreviewBackend, port: number, page: PageSink): Connection | null {
    let open = true;
    let server: Connection | null = null;
    let draining = false;
    const queue: Step[] = [];
    /** Read through a function where a loop awaits: the connection can end in between. */
    const isOpen = (): boolean => open;

    /** Ends the connection on both sides. What was waiting to be passed on is dropped. */
    const end = (): void => {
      if (!open) return;
      open = false;
      live.delete(end);
      settle(queue.splice(0));
      server?.close();
      page.end();
    };

    /** In the order the frames came; each may wait for the one before to be taken. */
    async function passOn(batch: readonly Step[]): Promise<void> {
      for (const step of batch) {
        if (!open) return;
        // oxlint-disable-next-line no-await-in-loop
        await step.run();
      }
    }

    /** One batch: passed on only on a yes that was asked after every frame in it arrived. */
    async function passBatch(batch: readonly Step[]): Promise<void> {
      try {
        if (await authorized()) return await passOn(batch);
        // Not this connection alone: whatever else is live was allowed by an older answer.
        revoke();
        end();
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
        end();
      } finally {
        draining = false;
        if (!open) settle(queue.splice(0));
      }
    }

    /** Queues one step. Resolves when it ran, or when the connection ended without it. */
    function pass(run: Step["run"]): Promise<void> {
      if (!open) return Promise.resolve();
      const ran = Promise.withResolvers<void>();
      queue.push({ run, settled: ran.resolve });
      void drain();
      return ran.promise;
    }

    /** The last step of a connection that ends by itself, after everything queued before it. */
    const finish = (last: () => void): void =>
      void pass(() => {
        open = false;
        live.delete(end);
        last();
      });

    server = backend.connect(port, {
      data: (bytes) => pass(() => page.data(bytes)),
      end: () => finish(() => page.end()),
      error: (message) => finish(() => page.error(message)),
    });
    if (!server) {
      open = false;
      return null;
    }
    const connection = server;
    live.add(end);
    return {
      write: (bytes) => void pass(() => connection.write(bytes)),
      close: () => finish(() => connection.close()),
    };
  }

  function request(backend: PreviewBackend, port: number, asked: Asked, page: ResponseSink): boolean {
    let open = true;
    const done = (): void => {
      open = false;
      live.delete(cut);
    };
    const cut = (): void => {
      if (!open) return;
      done();
      page.error(REVOKED);
    };
    const accepted = backend.request(port, asked, {
      head(head) {
        if (open) page.head(head);
      },
      data: (chunk) => (open ? page.data(chunk) : undefined),
      end() {
        if (!open) return;
        done();
        page.end();
      },
      error(message) {
        if (!open) return;
        done();
        page.error(message);
      },
    });
    if (accepted && open) live.add(cut);
    return accepted;
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
