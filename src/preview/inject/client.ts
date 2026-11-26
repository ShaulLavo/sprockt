// Runs inside every previewed page, before the page's own scripts. It gives the page a
// WebSocket that reaches its dev server (hot reload needs one), and it tells the preview pane
// where the page is and what went wrong in it.
import { frameMessage, isFrameCommand, type FrameMessage } from "../bridge";
import { keepNavigationMounted } from "./navigation";
import { tunnelTarget, type PageServer } from "./tunnel";
import { endTunnels, TunnelWebSocket } from "./websocket";

type Body = Parameters<typeof frameMessage>[0];

const script = document.currentScript;
const server: PageServer = {
  port: Number(script?.getAttribute("data-sprockt-port")),
  mount: script?.getAttribute("data-sprockt-mount") ?? "",
};
const NativeWebSocket = globalThis.WebSocket;

function installWebSocket(): void {
  class PreviewWebSocket extends TunnelWebSocket {
    static override [Symbol.hasInstance](value: unknown): boolean {
      return value instanceof NativeWebSocket || value instanceof TunnelWebSocket;
    }

    constructor(input: string | URL, protocols?: string | string[]) {
      const tunnel = tunnelTarget(input, new URL(location.href), server);
      // A constructor may return another object: sockets to other hosts stay the browser's own.
      if (!tunnel) return new NativeWebSocket(input, protocols) as unknown as PreviewWebSocket;
      super(tunnel, protocols);
    }
  }
  Object.defineProperty(globalThis, "WebSocket", {
    value: PreviewWebSocket,
    configurable: true,
    writable: true,
  });
  // A reload, a navigation or the removal of the frame: the page's sockets end with it.
  addEventListener("pagehide", endTunnels);
}

const text = (value: unknown) => (value instanceof Error ? value.message : String(value));

/** Tells the pane about this page. A page opened in its own tab has nobody to tell. */
function installBridge(pane: Window): void {
  // Mounted previews share the IDE's origin, so that is the only origin we talk to.
  const target = location.origin;
  const post = (body: Body) => pane.postMessage(frameMessage(body) satisfies FrameMessage, target);
  const reportLocation = () => post({ type: "location", href: location.href, title: document.title });

  post({ type: "started", href: location.href });
  addEventListener("DOMContentLoaded", reportLocation);
  addEventListener("load", reportLocation);
  addEventListener("popstate", reportLocation);
  addEventListener("hashchange", reportLocation);
  for (const method of ["pushState", "replaceState"] as const) {
    const original = history[method];
    history[method] = function (this: History, ...args: Parameters<History["pushState"]>) {
      original.apply(this, args);
      reportLocation();
    };
  }

  window.addEventListener("error", (event) =>
    post({ type: "error", message: event.message || "Resource failed to load" }),
  );
  window.addEventListener("unhandledrejection", (event) =>
    post({ type: "error", message: text(event.reason) }),
  );
  const consoleError = console.error;
  console.error = (...args: unknown[]) => {
    post({ type: "error", message: args.map(text).join(" ") });
    consoleError.apply(console, args);
  };

  addEventListener("message", (event) => {
    if (event.source !== pane || event.origin !== target || !isFrameCommand(event.data)) return;
    const command = event.data;
    if (command.command === "hello") post({ type: "hello", id: command.id });
    else if (command.command === "reload") location.reload();
    else location.assign(command.href);
  });
}

const served = Number.isInteger(server.port) && server.port > 0;
if (served) installWebSocket();
// Links and forms that say `/about` or `http://localhost:5173/login` mean the server's own
// places; they are kept inside its mount (navigation.ts).
if (served && server.mount) keepNavigationMounted(server, parent !== window);
if (parent !== window) installBridge(parent);
