// How many browser tabs have this workspace open and live, for the status bar's sharing
// indicator. Each live tab says hello on a BroadcastChannel, answers others, repeats itself
// every few seconds and says goodbye when it closes or stops being live.
import { createEffect, createSignal, on, onCleanup, type Accessor } from "../lib/reactive";

const HEARTBEAT_MS = 4000;
/** A tab not heard from for this long is gone (it crashed or its page froze). */
export const PEER_TTL_MS = 10_000;

type Message = { readonly kind: "hello" | "here" | "bye"; readonly tab: string };

/** Drops peers not heard from within the time limit. Returns the same map when nothing expired. */
export function prunePeers(peers: ReadonlyMap<string, number>, now: number): ReadonlyMap<string, number> {
  const alive = Array.from(peers).filter(([, seen]) => now - seen < PEER_TTL_MS);
  return alive.length === peers.size ? peers : new Map(alive);
}

function isMessage(value: unknown): value is Message {
  if (typeof value !== "object" || value === null) return false;
  const { kind, tab } = value as Record<string, unknown>;
  return typeof tab === "string" && (kind === "hello" || kind === "here" || kind === "bye");
}

/**
 * Counts the tabs (this one included) that have `workspaceId` open while `live()` is true.
 * Must run inside a Solid owner; it stops when the owner is cleaned up.
 */
export function trackPresence(workspaceId: string, live: Accessor<boolean>): Accessor<number> {
  const [peers, setPeers] = createSignal<ReadonlyMap<string, number>>(new Map());
  if (typeof BroadcastChannel !== "function") return () => 1;
  const tab = crypto.randomUUID();
  const channel = new BroadcastChannel(`sprockt:${workspaceId}:presence`);
  // A BroadcastChannel only reaches same-origin pages and takes no target origin.
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  const post = (kind: Message["kind"]) => channel.postMessage({ kind, tab } satisfies Message);

  channel.addEventListener("message", ({ data }: MessageEvent<unknown>) => {
    if (!isMessage(data) || data.tab === tab) return;
    if (data.kind === "bye") {
      setPeers((current) => new Map(Array.from(current).filter(([id]) => id !== data.tab)));
      return;
    }
    setPeers((current) => new Map(current).set(data.tab, Date.now()));
    if (data.kind === "hello" && live()) post("here");
  });

  const beat = setInterval(() => {
    if (live()) post("here");
    setPeers((current) => prunePeers(current, Date.now()));
  }, HEARTBEAT_MS);
  const leave = () => post("bye");
  addEventListener("pagehide", leave);
  // Saying hello asks every other live tab to answer; losing liveness is a goodbye.
  createEffect(on(live, (isLive) => post(isLive ? "hello" : "bye")));

  onCleanup(() => {
    clearInterval(beat);
    removeEventListener("pagehide", leave);
    leave();
    channel.close();
  });
  return () => (live() ? peers().size + 1 : 0);
}
