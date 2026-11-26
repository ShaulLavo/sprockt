import { expect, test } from "bun:test";
import {
  PREVIEW_IDENTITY_PATH,
  previewIdentity,
  type IdentityFilesystem,
  type IdentityLocks,
} from "./identity";

interface FakeFilesystem extends IdentityFilesystem {
  readonly files: Map<string, string>;
  readonly flushed: string[];
}

/** A filesystem every "tab" shares, as tabs of a workspace do. Reads take a turn, as real ones do. */
function sharedFilesystem(): FakeFilesystem {
  const files = new Map<string, string>();
  const flushed: string[] = [];
  return {
    files,
    flushed,
    async readFile(path) {
      await Promise.resolve();
      const text = files.get(path);
      return text === undefined ? undefined : new TextEncoder().encode(text);
    },
    async writeFile(path, content) {
      await Promise.resolve();
      files.set(path, content);
    },
    mkdirp: async () => {},
    async flush() {
      flushed.push(files.get(PREVIEW_IDENTITY_PATH) ?? "");
    },
  };
}

/** Web Locks across the "tabs" of one browser: one holder of a name at a time, in order. */
function sharedLocks(): IdentityLocks & { readonly names: string[] } {
  const queues = new Map<string, Promise<unknown>>();
  const names: string[] = [];
  return {
    names,
    request(name, task) {
      names.push(name);
      const run = (queues.get(name) ?? Promise.resolve()).then(task);
      queues.set(
        name,
        run.catch(() => {}),
      );
      return run;
    },
  };
}

/** No locking at all: every caller runs at once, as tabs would without the lock. */
const noLocks: IdentityLocks = { request: (_name, task) => task() };

test("the identity is created once, stored in the workspace, and read back afterwards", async () => {
  const filesystem = sharedFilesystem();
  const first = await previewIdentity("abc", filesystem, sharedLocks());
  expect(first).toMatch(/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/);
  expect(filesystem.files.get(PREVIEW_IDENTITY_PATH)).toBe(`${first}\n`);
  // Durable before it is used: a host name derived from it must still be the same after a reload.
  expect(filesystem.flushed).toEqual([`${first}\n`]);
  const locks = sharedLocks();
  expect(await previewIdentity("abc", filesystem, locks)).toBe(first);
  // An identity that exists is read without waiting for anyone.
  expect(locks.names).toEqual([]);
});

test("tabs that ask at the same moment get the same identity", async () => {
  const filesystem = sharedFilesystem();
  const locks = sharedLocks();
  const asked = await Promise.all([
    previewIdentity("abc", filesystem, locks),
    previewIdentity("abc", filesystem, locks),
    previewIdentity("abc", filesystem, locks),
  ]);
  expect(new Set(asked).size).toBe(1);
  expect(locks.names).toEqual(Array.from({ length: 3 }, () => "sprockt:abc:preview-identity"));
});

test("without the lock the same tabs would disagree, which is what the lock is for", async () => {
  const filesystem = sharedFilesystem();
  const asked = await Promise.all([
    previewIdentity("abc", filesystem, noLocks),
    previewIdentity("abc", filesystem, noLocks),
  ]);
  expect(new Set(asked).size).toBe(2);
});

test("a workspace that was deleted and created again gets a new identity", async () => {
  const first = await previewIdentity("abc", sharedFilesystem(), sharedLocks());
  const second = await previewIdentity("abc", sharedFilesystem(), sharedLocks());
  expect(second).not.toBe(first);
});

test("a file that holds something else is replaced, not used as a host name", async () => {
  const filesystem = sharedFilesystem();
  filesystem.files.set(PREVIEW_IDENTITY_PATH, "../../etc\n");
  const identity = await previewIdentity("abc", filesystem, sharedLocks());
  expect(identity).toMatch(/^[\da-f-]{36}$/);
  expect(filesystem.files.get(PREVIEW_IDENTITY_PATH)).toBe(`${identity}\n`);
});
