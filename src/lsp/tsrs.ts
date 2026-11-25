// tsrs, TypeScript's checker ported to Rust, as one wasm32-wasip1 command (`tsrs-lsp.wasm`)
// with TypeScript's `lib.*.d.ts` files embedded. It runs straight on Waffle: no Bun, one
// process, a 1 GiB memory maximum. It reads the project through the runtime root at the same
// absolute paths the editor uses, `node_modules` included.
import type { Runtime } from "waffle";
import { installPrograms } from "waffle/programs";
import { programLauncher } from "../runtime/boot";
import { runtimeAssets } from "../runtime/assets";
import { guestEntries, guestMismatch, guestPath } from "../runtime/guests";
import type { TypeScriptServer } from "./servers";

/** Where the server is installed. It takes no flags and speaks LSP over stdin and stdout. */
export const TSRS_LSP_PATH = "/usr/bin/tsrs-lsp";

const GUEST = "tsrs-lsp.wasm";

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The staged guest, checked against its pin. Its URL is immutable, so the HTTP cache keeps it. */
async function download(): Promise<Uint8Array> {
  const response = await fetch(guestPath(GUEST));
  if (!response.ok) throw new Error(`${GUEST}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const mismatch = guestMismatch(guestEntries[GUEST], bytes.byteLength, await sha256(bytes));
  if (mismatch) throw new Error(`${GUEST} is not the pinned build (${mismatch})`);
  return bytes;
}

/**
 * Downloads first, so the server's first start only compiles: a download on a slow link inside
 * the first start would count against the `initialize` timeout.
 */
async function install(runtime: Runtime): Promise<void> {
  const bytes = await download();
  await installPrograms(
    runtime,
    [{ name: "tsrs-lsp", programs: [{ path: TSRS_LSP_PATH, source: async () => bytes }] }],
    { launcher: programLauncher(runtimeAssets.programWorker) },
  );
}

/** Installed once per runtime: an editor that mounts again reuses the installation. */
const installed = new WeakMap<Runtime, Promise<void>>();

export const tsrs: TypeScriptServer = {
  name: "tsrs",
  async install(runtime, projectRoot) {
    let installation = installed.get(runtime);
    if (!installation) {
      installation = install(runtime);
      installed.set(runtime, installation);
      installation.catch(() => installed.delete(runtime));
    }
    await installation;
    return { executable: TSRS_LSP_PATH, args: [], rootPath: projectRoot, env: { PWD: projectRoot } };
  },
};
