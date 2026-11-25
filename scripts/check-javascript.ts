// Fails when a hand-written JavaScript file is tracked in the repository.
import { handWrittenJavaScript } from "./javascript-files";

/** Prefixes where JavaScript is allowed, each with the reason. Empty today. */
const ALLOWED: readonly string[] = [];

const listing = Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard"]);
if (listing.exitCode !== 0) throw new Error(`git ls-files failed: ${listing.stderr.toString()}`);

const found = handWrittenJavaScript(listing.stdout.toString().split("\n").filter(Boolean), ALLOWED);
if (found.length > 0) {
  console.error(`Hand-written code must be TypeScript. Found JavaScript:\n${found.join("\n")}`);
  process.exit(1);
}
console.log("No hand-written JavaScript.");
