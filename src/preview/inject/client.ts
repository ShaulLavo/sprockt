// Runs inside every previewed page, before the page's own scripts. It gives the page a
// WebSocket that reaches its dev server (hot reload needs one), and it tells the preview pane
// where the page is and what went wrong in it.
import { frameMessage, isFrameCommand, type FrameMessage } from "../bridge";
import { tunnelTarget, type PageServer } from "./tunnel";
import { TunnelWebSocket } from "./websocket";

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
    if (event.data.command === "reload") location.reload();
    else location.assign(event.data.href);
  });
}

/**
 * A link to `/about` means the server's `/about`, but in a mounted preview the browser would
 * leave the mount and load the IDE's own `/about`. Such a click is sent to the mounted path
 * instead. A click the page's own router already handled is left alone.
 */
function keepLinksMounted(): void {
  window.addEventListener("click", (event) => {
    const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!(anchor instanceof HTMLAnchorElement) || event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || (anchor.target && anchor.target !== "_self"))
      return;
    const url = new URL(anchor.href);
    const mounted = url.pathname === server.mount || url.pathname.startsWith(`${server.mount}/`);
    if (url.origin !== location.origin || mounted) return;
    event.preventDefault();
    location.assign(server.mount + url.pathname + url.search + url.hash);
  });
}

if (Number.isInteger(server.port) && server.port > 0) installWebSocket();
if (server.mount) keepLinksMounted();
if (parent !== window) installBridge(parent);
