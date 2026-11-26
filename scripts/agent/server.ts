import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { resolve } from "node:path";

export interface PreviewServerHandle {
  readonly url: string;
  readonly port: number;
  readonly owned: boolean;
  readonly logs: () => string;
  readonly stop: () => Promise<void>;
}

function closeServerAndReturnPort(server: Server): Promise<number> {
  const address = server.address();
  if (!address || typeof address === "string") {
    return new Promise((_, rejectPort) => {
      server.close(() => rejectPort(new Error("Could not determine free loopback port")));
    });
  }
  const { port } = address;
  return new Promise((resolvePort, rejectPort) => {
    server.close((error) => {
      if (error) rejectPort(error);
      else resolvePort(port);
    });
  });
}

function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.unref();
    server.on("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      void closeServerAndReturnPort(server).then(resolvePort, rejectPort);
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

function sendSignalSafe(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    // Process already exited.
  }
}

function stopChildProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((done) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(safetyTimer);
      done();
    };
    const killTimer = setTimeout(() => sendSignalSafe(child, "SIGKILL"), 3000);
    const safetyTimer = setTimeout(finish, 8000);
    child.once("exit", finish);
    child.once("close", finish);
    sendSignalSafe(child, "SIGTERM");
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
  let stopping: Promise<void> | undefined;
  return {
    url,
    port,
    owned: true,
    logs: () => chunks.join(""),
    stop: () => {
      stopping ??= stopChildProcess(child);
      return stopping;
    },
  };
}
