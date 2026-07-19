import { execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const STABLE_GUI_HOST = "localhost";
export const STABLE_GUI_PORT = 3000;
export const STABLE_GUI_FALLBACK_PORTS = [3001] as const;

export interface PortListener {
  pid: number;
  port: number;
  command: string;
}

export function looksLikeGuiDevServer(command: string): boolean {
  const normalized = command.toLowerCase();
  return (
    normalized.includes("next dev") ||
    (normalized.includes("next") && normalized.includes("dev")) ||
    (normalized.includes("apps/gui") && normalized.includes("next"))
  );
}

export async function listPortListeners(port: number): Promise<PortListener[]> {
  if (process.platform === "win32") {
    return [];
  }

  try {
    const { stdout } = await execFileAsync("lsof", [
      "-nP",
      `-iTCP:${port}`,
      "-sTCP:LISTEN",
      "-F",
      "pcn",
    ]);

    return parseLsofOutput(stdout, port);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("lsof")) {
      return [];
    }
    throw error;
  }
}

function parseLsofOutput(stdout: string, port: number): PortListener[] {
  const entries: PortListener[] = [];
  let currentPid: number | undefined;
  let currentCommand = "";

  for (const line of stdout.split("\n")) {
    if (!line) {
      if (currentPid !== undefined) {
        entries.push({
          pid: currentPid,
          port,
          command: currentCommand.trim(),
        });
        currentPid = undefined;
        currentCommand = "";
      }
      continue;
    }

    const tag = line[0];
    const value = line.slice(1);
    if (tag === "p") {
      currentPid = Number.parseInt(value, 10);
    } else if (tag === "c") {
      currentCommand = value;
    }
  }

  if (currentPid !== undefined) {
    entries.push({
      pid: currentPid,
      port,
      command: currentCommand.trim(),
    });
  }

  return entries.filter((entry) => Number.isFinite(entry.pid));
}

export async function readProcessCommand(pid: number): Promise<string> {
  if (process.platform === "win32") {
    return "";
  }

  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "args="]);
    return stdout.trim();
  } catch {
    return "";
  }
}

export async function stopProcess(pid: number): Promise<void> {
  if (process.platform === "win32") {
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("ESRCH")) {
      throw error;
    }
  }

  await sleep(400);

  try {
    process.kill(pid, 0);
    process.kill(pid, "SIGKILL");
  } catch {
    // Process already exited.
  }
}

export async function stopChildProcess(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) {
    return;
  }

  await stopProcess(child.pid);
}

export interface StopStaleGuiServersResult {
  stopped: Array<{ pid: number; port: number; command: string }>;
}

export async function stopStaleGuiServers(
  ports: readonly number[] = [STABLE_GUI_PORT, ...STABLE_GUI_FALLBACK_PORTS],
): Promise<StopStaleGuiServersResult> {
  const stopped: StopStaleGuiServersResult["stopped"] = [];

  for (const port of ports) {
    const listeners = await listPortListeners(port);
    for (const listener of listeners) {
      const command =
        listener.command || (await readProcessCommand(listener.pid));
      if (!looksLikeGuiDevServer(command)) {
        continue;
      }

      await stopProcess(listener.pid);
      stopped.push({ pid: listener.pid, port, command });
    }
  }

  if (stopped.length > 0) {
    await sleep(500);
  }

  return { stopped };
}

export async function assertStableGuiPortAvailable(
  port: number = STABLE_GUI_PORT,
  host: string = STABLE_GUI_HOST,
): Promise<void> {
  const listeners = await listPortListeners(port);
  if (listeners.length === 0) {
    return;
  }

  const blocking: string[] = [];
  for (const listener of listeners) {
    const command =
      listener.command || (await readProcessCommand(listener.pid));
    if (looksLikeGuiDevServer(command)) {
      await stopProcess(listener.pid);
      await sleep(400);
      continue;
    }

    blocking.push(
      `PID ${listener.pid}${command ? ` (${command})` : ""} on port ${port}`,
    );
  }

  const remaining = await listPortListeners(port);
  if (remaining.length > 0) {
    const details = blocking.length
      ? blocking.join("; ")
      : remaining
          .map((listener) => `PID ${listener.pid} on port ${port}`)
          .join("; ");
    throw new Error(
      `Port ${port} on ${host} is occupied by a non-GUI process: ${details}. Free port ${port} before running harness:configure:stable.`,
    );
  }
}

export async function cleanGuiNextCache(repoRoot: string): Promise<string> {
  const nextDir = path.join(repoRoot, "apps", "gui", ".next");
  await fs.rm(nextDir, { recursive: true, force: true });
  return nextDir;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
