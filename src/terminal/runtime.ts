// One shared Ghostty WASM runtime per page, borrowed by every terminal tab and split so opening
// extra shells never recompiles the WASM module or duplicates bridge allocations.
import { GhosttyRuntime } from "ghostty-webgpu";
import terminalBridge from "ghostty-webgpu/bridge.wasm?url";
import terminalWasm from "ghostty-webgpu/ghostty-vt.wasm?url";

let shared: Promise<GhosttyRuntime> | undefined;

export function getSharedGhosttyRuntime(): Promise<GhosttyRuntime> {
  if (!shared) {
    shared = GhosttyRuntime.create({
      wasm: new URL(terminalWasm, location.href),
      bridge: new URL(terminalBridge, location.href),
    }).catch((error: unknown) => {
      shared = undefined;
      throw error;
    });
  }
  return shared;
}
