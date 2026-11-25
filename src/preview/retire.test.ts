import { expect, test } from "bun:test";
import { isPreviewsOff } from "./host-protocol";
import { retirePreviewWorker } from "./retire";

const ORIGIN = "https://ide.test";

function registration(scope: string, states: readonly ("active" | "waiting" | "installing")[]) {
  const told: unknown[] = [];
  const worker = { postMessage: (message: unknown) => void told.push(message) } as unknown as ServiceWorker;
  const entry = {
    scope,
    active: states.includes("active") ? worker : null,
    waiting: states.includes("waiting") ? worker : null,
    installing: states.includes("installing") ? worker : null,
    unregistered: 0,
    told,
    async unregister() {
      entry.unregistered++;
      return true;
    },
  };
  return entry;
}

test("the preview worker of an earlier build is told to stop and is unregistered", async () => {
  const preview = registration(`${ORIGIN}/__preview/`, ["active", "waiting"]);
  const container = { getRegistrations: async () => [preview] };
  expect(await retirePreviewWorker(container, ORIGIN)).toBe(1);
  expect(preview.unregistered).toBe(1);
  // Both the worker in charge and the one waiting to replace it hear it.
  expect(preview.told).toHaveLength(2);
  expect(preview.told.every(isPreviewsOff)).toBe(true);
});

test("a worker of any other scope is left alone", async () => {
  const other = registration(`${ORIGIN}/`, ["active"]);
  const nested = registration(`${ORIGIN}/__preview/abc/`, ["active"]);
  const container = { getRegistrations: async () => [other, nested] };
  expect(await retirePreviewWorker(container, ORIGIN)).toBe(0);
  expect(other.unregistered + nested.unregistered).toBe(0);
  expect(other.told.concat(nested.told)).toHaveLength(0);
});

test("a browser without service workers has nothing to retire", async () => {
  expect(await retirePreviewWorker(undefined, ORIGIN)).toBe(0);
});
