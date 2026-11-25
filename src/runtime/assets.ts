// Every worker and guest URL the runtime needs, resolved once. Workers are bundled by Vite;
// guests are the pinned files that scripts/fetch-guests.ts stages under /guests.
import bunWorker from "bun-wasm/worker?worker&url";
import bunNotificationWorker from "bun-wasm/notification-worker?worker&url";
import filesystemWorker from "waffle/browser/fs-worker?worker&url";
import shellWorker from "../../node_modules/bash-web/src/runtime/worker.ts?worker&url";
import programWorker from "../../node_modules/bun-wasm/web/src/preview1-worker.ts?worker&url";
import { guestEntries, guestPath, type GuestName } from "./guests";

const absolute = (path: string): URL => new URL(path, location.origin);

function guestFile(name: GuestName) {
  const { sha256, bytes } = guestEntries[name];
  return { url: absolute(guestPath(name)).href, sha256, bytes };
}

export const runtimeAssets = {
  filesystemWorker: absolute(filesystemWorker),
  programWorker: absolute(programWorker),
  bunWorker: absolute(bunWorker),
  bunNotificationWorker: absolute(bunNotificationWorker),
  shellWorker: absolute(shellWorker),
  shellGuest: absolute(guestPath("shell-engine.wasm")),
  /** The browser-engine Bun guest, checked against its hash before it is compiled. */
  bunGuest: { kind: "single", core: guestFile("bun-browser.wasm") },
} as const;
