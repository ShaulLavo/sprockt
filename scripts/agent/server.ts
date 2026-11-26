import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";

export interface PreviewServerHandle {
  readonly url: string;
  readonly port: number;
  readonly owned: boolean;
  readonly logs: () => string;
  readonly stop: () => Promise<void>;
}

function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.unref();
    server.on("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => rejectPort(new Error("Could not determine free loopback port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) rejectPort(error);
        else resolvePort(port);
      });
    });
  });
}

async function pollServerReady(
  url: string,
  child: ChildProcess,
  logs: string[],
  deadline: number,
): Promise<void> {
  if (child.exitCode !== null) {
    throw new Error(`vite preview exited early (${child.exitCode}):\n${logs.join("")}`);
  }
  try {
    const res = await fetch(url);
    if (res.ok) return;
  } catch {
    // Server still binding.
  }
  if (Date.now() >= deadline) {
    throw new Error(`Timed out waiting for ${url} to answer:\n${logs.join("")}`);
  }
  await new Promise((done) => setTimeout(done, 150));
  return pollServerReady(url, child, logs, deadline);
}

function waitForServerReady(url: string, child: ChildProcess, logs: string[]): Promise<void> {
  return pollServerReady(url, child, logs, Date.now() + 30_000);
}

function stopChildProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) return Promise.resolve();
  return new Promise((done) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      done();
    }, 3000);
    child.once("exit", () => {
      clearTimeout(timer);
      done();
    });
    try {
      child.kill("SIGTERM");
    } catch {
      clearTimeout(timer);
      done();
    }
  });
}

/**
 * Starts a private throwaway `vite preview` server serving `dist/` on a free loopback port.
 * Never kills unrelated servers or touches user state.
 */
export async function startThrowawayPreviewServer(repoRoot: string): Promise<PreviewServerHandle> {
  const distIndex = resolve(repoRoot, "dist", "index.html");
  if (!existsSync(distIndex)) {
    throw new Error(
      `Built app not found at ${distIndex}. Build first with:\n  VITE_SPROCKT_PREVIEWS=mounted bun run build`,
    );
  }
  const port = await allocateLoopbackPort();
  const url = `http://127.0.0.1:${port}`;
  const chunks: string[] = [];
  const child = spawn(
    "bunx",
    ["vite", "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", (buf: Buffer) => chunks.push(buf.toString("utf8")));
  child.stderr?.on("data", (buf: Buffer) => chunks.push(buf.toString("utf8")));
  try {
    await waitForServerReady(url, child, chunks);
  } catch (error) {
    await stopChildProcess(child);
    throw error;
  }
  return {
    url,
    port,
    owned: true,
    logs: () => chunks.join(""),
    stop: () => stopChildProcess(child),
  };
}
