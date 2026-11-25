import lock from "../../guests.lock.json";

/** One pinned guest: where its bytes come from and what they must hash to. */
export interface GuestEntry {
  readonly source: string;
  readonly sha256: string;
  readonly bytes: number;
}

export type GuestName = keyof typeof lock.guests;

export const guestEntries: Readonly<Record<GuestName, GuestEntry>> = lock.guests;

/** Path under the site root. The hash is in the path, so the file can be cached forever. */
export function guestPath(name: GuestName): string {
  return `/guests/${guestEntries[name].sha256}/${name}`;
}

/** Why a downloaded guest is not the pinned one, or undefined when it matches. */
export function guestMismatch(entry: GuestEntry, bytes: number, sha256: string): string | undefined {
  if (bytes !== entry.bytes) return `expected ${entry.bytes} bytes, received ${bytes}`;
  if (sha256 !== entry.sha256) return `expected SHA-256 ${entry.sha256}, received ${sha256}`;
  return undefined;
}
