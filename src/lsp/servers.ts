// The seam between "TypeScript IntelliSense" and the server that provides it. tsrs is the one
// built today. typescript-language-server under bun-wasm slots in as a second implementation:
// it installs its npm packages into the workspace and answers
// `{ executable: "/bin/bun", args: [<root>/node_modules/typescript-language-server/lib/cli.mjs, "--stdio"] }`,
// and needs `initializationOptions` (no automatic type acquisition, no syntax server), a
// writable `/tmp` and TypeScript 6.0.x; the glue already passes `programs: "guest"` and
// `onLeaderExit: "stop"`, which Bun and its forked tsserver need.
import type { Runtime } from "waffle";
import type { GuestServer } from "./glue";

export interface TypeScriptServer {
  readonly name: string;
  /**
   * Makes the server runnable on `runtime` and says how to start it. Resolves only once the
   * program is installed: the plugin starts it as soon as it mounts.
   */
  install(runtime: Runtime, projectRoot: string): Promise<GuestServer>;
}
