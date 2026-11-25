// Stages the pinned WASM guests into public/guests/<sha256>/<name>.
//
// bun-wasm and bash-web publish no guest files yet, so guests.lock.json pins the ones that
// bun.sprockt.dev serves for the recorded bun-wasm commit. Every file is checked against its
// pinned size and SHA-256 before it is staged. SPROCKT_GUEST_CACHE names a directory that keeps
// verified copies between checkouts and CI runs.
import { readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { guestEntries, guestMismatch, type GuestEntry, type GuestName } from "../src/runtime/guests";

const root = resolve(import.meta.dir, "..");
const staged = join(root, "public/guests");
const cache = process.env.SPROCKT_GUEST_CACHE ?? join(root, "node_modules/.cache/sprockt-guests");

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

async function verified(path: string, entry: GuestEntry): Promise<Uint8Array | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  const bytes = await file.bytes();
  return guestMismatch(entry, bytes.byteLength, sha256(bytes)) ? undefined : bytes;
}

async function download(name: GuestName, entry: GuestEntry): Promise<Uint8Array> {
  const response = await fetch(entry.source);
  if (!response.ok) throw new Error(`${name}: ${entry.source} answered HTTP ${response.status}`);
  const bytes = await response.bytes();
  const mismatch = guestMismatch(entry, bytes.byteLength, sha256(bytes));
  if (mismatch) {
    throw new Error(
      `${name}: ${entry.source} no longer serves the pinned guest (${mismatch}). ` +
        "Move guests.lock.json and the bun-wasm dependency to the same newer commit.",
    );
  }
  await Bun.write(join(cache, `${entry.sha256}.wasm`), bytes);
  return bytes;
}

async function stage(name: GuestName, entry: GuestEntry): Promise<string> {
  const target = join(staged, entry.sha256, name);
  if (await verified(target, entry)) return "already staged";
  const cached = await verified(join(cache, `${entry.sha256}.wasm`), entry);
  await Bun.write(target, cached ?? (await download(name, entry)));
  return cached ? "from cache" : "downloaded";
}

/** Guests of an earlier pin would otherwise ship with every build. */
async function removeStale(keep: ReadonlySet<string>): Promise<void> {
  const present = await readdir(staged).catch(() => []);
  const stale = present.filter((directory) => !keep.has(directory));
  await Promise.all(stale.map((directory) => rm(join(staged, directory), { recursive: true })));
}

const names = Object.keys(guestEntries) as GuestName[];
const outcomes = await Promise.all(names.map((name) => stage(name, guestEntries[name])));
await removeStale(new Set(names.map((name) => guestEntries[name].sha256)));
for (const [index, name] of names.entries()) {
  const megabytes = (guestEntries[name].bytes / 1024 / 1024).toFixed(1);
  console.log(`${name}: ${outcomes[index]} (${megabytes} MB)`);
}
