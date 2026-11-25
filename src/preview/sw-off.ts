// What a build without previews publishes where the preview service worker would be. A browser
// that still has the worker of an earlier build checks this address for a newer one: it finds
// this, which takes over at once, serves nothing (it has no fetch handler) and removes its own
// registration.
// Makes this file a module, so its `self` is not the page's.
// oxlint-disable-next-line unicorn/require-module-specifiers
export {};

declare const self: ServiceWorkerGlobalScope;

self.addEventListener("install", () => void self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.registration.unregister()));
