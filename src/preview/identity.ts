// A workspace's preview identity: a random value stored inside the workspace, beside its
// metadata. Preview host names are derived from it, so every tab of a workspace computes the
// same names, and a workspace that was deleted and created again gets new ones: it never
// inherits the cookies or the storage its predecessor's pages left on their origins.
import { WORKSPACE_META_DIR } from "../importer/metadata";

/** On the workspace filesystem's root, outside the project, like the metadata itself. */
export const PREVIEW_IDENTITY_PATH = `${WORKSPACE_META_DIR}/preview-identity`;

const SHAPE = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;

/** The filesystem calls the identity needs; `runtime.filesystem` provides them. */
export interface IdentityFilesystem {
  readFile(path: string): Promise<Uint8Array | undefined>;
  writeFile(path: string, content: string): Promise<unknown>;
  mkdirp(path: string): Promise<unknown>;
  flush(): Promise<unknown>;
}

/** The part of the Web Locks API used here. */
export interface IdentityLocks {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

async function stored(filesystem: IdentityFilesystem): Promise<string | undefined> {
  const bytes = await filesystem.readFile(PREVIEW_IDENTITY_PATH);
  const text = bytes ? new TextDecoder().decode(bytes).trim() : "";
  return SHAPE.test(text) ? text : undefined;
}

async function create(filesystem: IdentityFilesystem): Promise<string> {
  // Another tab may have written it while this one waited for the lock.
  const existing = await stored(filesystem);
  if (existing) return existing;
  const identity = crypto.randomUUID();
  await filesystem.mkdirp(WORKSPACE_META_DIR);
  await filesystem.writeFile(PREVIEW_IDENTITY_PATH, `${identity}\n`);
  await filesystem.flush();
  return identity;
}

/**
 * The workspace's preview identity, created on first use. Tabs of a workspace share one live
 * filesystem, and the lock makes "read, and write if missing" one step across them, so two
 * tabs that ask at the same moment get the same value.
 */
export async function previewIdentity(
  workspace: string,
  filesystem: IdentityFilesystem,
  locks: IdentityLocks = navigator.locks,
): Promise<string> {
  const existing = await stored(filesystem);
  if (existing) return existing;
  return locks.request(`sprockt:${workspace}:preview-identity`, () => create(filesystem));
}
