// Adapts Sprockt's PreviewTransport (mounted SW or isolated subdomain) + remote dev-server ports
// onto @shaulavo/workbench/core's PreviewAdapter and PreviewFrameController.
import type {
  PreviewAdapter,
  PreviewFrameController,
  PreviewFrameEvent,
  PreviewServerInfo,
  Subscribable,
} from "@shaulavo/workbench/core";
import { frameCommand, type FrameMessage } from "../bridge";
import { normalizePreviewPath } from "../paths";
import { listedPorts } from "./server-status";
import type { PreviewServer, PreviewTransport } from "../transport";

function withoutFragment(path: string): string {
  const hash = path.indexOf("#");
  return hash === -1 ? path : path.slice(0, hash) || "/";
}

function sameServerList(a: readonly PreviewServerInfo[], b: readonly PreviewServerInfo[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]?.port !== b[i]?.port || a[i]?.label !== b[i]?.label) return false;
  }
  return true;
}

export interface WafflePreviewAdapter extends PreviewAdapter {
  setRemotePorts(ports: readonly number[]): void;
  dispose(): void;
}

export function createWafflePreviewAdapter(preview: PreviewTransport): WafflePreviewAdapter {
  let localServers: readonly PreviewServer[] = preview.servers();
  let remotePorts: readonly number[] = [];
  let usable = preview.kind === "none";
  let snapshot: readonly PreviewServerInfo[] = [];
  const listeners = new Set<() => void>();

  function computeServers(): readonly PreviewServerInfo[] {
    if (!usable) return [];
    const labelByPort = new Map<number, string | undefined>();
    for (const srv of localServers) labelByPort.set(srv.port, srv.label);
    return listedPorts(
      localServers.map((srv) => srv.port),
      remotePorts,
    ).map((port) => {
      const label = labelByPort.get(port);
      return label ? { port, label } : { port };
    });
  }

  function emitServers(): void {
    const next = computeServers();
    if (sameServerList(snapshot, next)) return;
    snapshot = next;
    for (const listener of listeners) listener();
  }

  const readyPromise = (async () => {
    await preview.whenReady();
    usable = true;
    emitServers();
  })();
  // Prevent unhandled rejection when transport is unavailable; PreviewPane handles rejection via whenReady().
  void readyPromise.catch(() => {});

  const stopPreviewSub = preview.subscribe((next) => {
    localServers = next;
    emitServers();
  });

  const servers: Subscribable<readonly PreviewServerInfo[]> = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  function attachFrame(
    frame: HTMLIFrameElement,
    port: number,
    onEvent: (event: PreviewFrameEvent) => void,
    options?: { readonly initialPath?: string },
  ): PreviewFrameController {
    let disposed = false;
    let currentPath = normalizePreviewPath(options?.initialPath ?? "/");
    let helloSeq = 0;
    let acknowledged = false;

    const sendHello = (): void => {
      helloSeq += 1;
      acknowledged = false;
      const origin = URL.parse(frame.src)?.origin;
      if (!preview.takesCommands || !origin) {
        onEvent({ type: "bridge-ready", supported: false });
        return;
      }
      frame.contentWindow?.postMessage(frameCommand({ command: "hello", id: helloSeq }), origin);
    };

    const handleMessage = (message: FrameMessage): void => {
      if (disposed) return;
      if (message.type === "error") {
        onEvent({ type: "error", message: message.message });
        return;
      }
      if (message.type === "hello") {
        if (message.id !== helloSeq) return;
        acknowledged = true;
        onEvent({ type: "bridge-ready", supported: true });
        return;
      }
      const place = preview.locate(message.href);
      if (!place || place.port !== port) return;
      currentPath = place.path;
      if (message.type === "started") {
        onEvent({ type: "started", location: { port, path: place.path } });
        return;
      }
      onEvent({ type: "navigate", location: { port, path: place.path } });
      if (message.title) onEvent({ type: "title", title: message.title });
    };

    const stopWatch = preview.watch(frame, handleMessage);

    function loadPath(rawPath: string): void {
      if (disposed) return;
      const target = normalizePreviewPath(rawPath);
      currentPath = target;
      const href = preview.frameUrl(port, target);
      if (acknowledged) {
        frame.contentWindow?.postMessage(frameCommand({ command: "navigate", href }), new URL(href).origin);
        return;
      }
      frame.src = href;
      onEvent({ type: "navigate", location: { port, path: target } });
    }

    return {
      onFrameLoad: sendHello,
      navigate: loadPath,
      reload() {
        if (disposed) return;
        const href = preview.frameUrl(port, currentPath);
        if (acknowledged) {
          frame.contentWindow?.postMessage(frameCommand({ command: "reload" }), new URL(href).origin);
          return;
        }
        // Bridgeless reload strips any #fragment so reassigning frame.src performs a real reload,
        // replacing the current history entry in place so Back returns to the previous page.
        const target = withoutFragment(currentPath);
        currentPath = target;
        onEvent({ type: "navigate", location: { port, path: target }, replace: true });
        frame.src = preview.frameUrl(port, target);
      },
      back() {},
      forward() {},
      dispose() {
        if (disposed) return;
        disposed = true;
        acknowledged = false;
        stopWatch();
      },
    };
  }

  return {
    kind: preview.kind,
    servers,
    whenReady: () => readyPromise,
    frameUrl: (port, path) => preview.frameUrl(port, normalizePreviewPath(path)),
    tabUrl: (port, path) => preview.tabUrl(port, normalizePreviewPath(path)),
    locate: (href) => preview.locate(href),
    attachFrame,
    onReloadNeeded: (listener) => preview.onReloadNeeded(listener),
    setRemotePorts(next) {
      remotePorts = next;
      emitServers();
    },
    dispose() {
      stopPreviewSub();
      listeners.clear();
    },
  };
}
