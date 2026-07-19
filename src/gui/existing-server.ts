import net from "node:net";
import path from "node:path";
import { waitForConfigureServer } from "./configure-health.js";
import { checkRuntimeIntegrity } from "./runtime-integrity.js";
import {
  cleanupStaleRegistryRecords,
  computeRegistryIdentityHash,
  isProcessAlive,
  isRegistryRecordStale,
  listRegistryRecords,
  type RuntimeRegistryRecord,
} from "./runtime-registry.js";
import {
  DEFAULT_GUI_PORT,
  resolveAvailableGuiPort,
  resolveGuiHost,
  resolveRequestedGuiPort,
} from "./port.js";

export interface ExistingServerMatch {
  record: RuntimeRegistryRecord;
  url: string;
}

export interface PortResolutionResult {
  host: string;
  port: number;
  requestedPort: number;
  reusedExisting: boolean;
}

function normalizePath(value: string): string {
  return path.resolve(value);
}

function pathsMatch(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right);
}

function buildUrl(host: string, port: number, route = "/"): string {
  const normalizedRoute = route.startsWith("/") ? route : `/${route}`;
  return `http://${host}:${port}${normalizedRoute}`;
}

export function isPortAvailable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host, port }, () => {
      server.close(() => resolve(true));
    });
  });
}

export async function listPortListeners(port: number): Promise<number[]> {
  if (process.platform === "win32") {
    return [];
  }

  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  try {
    const { stdout } = await execFileAsync("lsof", [
      "-nP",
      `-iTCP:${port}`,
      "-sTCP:LISTEN",
      "-F",
      "pcn",
    ]);
    const pids: number[] = [];
    for (const line of stdout.split("\n")) {
      if (line.startsWith("p")) {
        const pid = Number.parseInt(line.slice(1), 10);
        if (Number.isFinite(pid)) {
          pids.push(pid);
        }
      }
    }
    return pids;
  } catch {
    return [];
  }
}

async function verifyRegistryRecordHealth(
  record: RuntimeRegistryRecord,
): Promise<boolean> {
  if (isRegistryRecordStale(record)) {
    return false;
  }

  const baseUrl = `http://${record.host}:${record.port}`;
  try {
    await waitForConfigureServer(baseUrl, 5_000);
    const integrity = await checkRuntimeIntegrity({
      baseUrl,
      expectedPid: record.pid,
      portOwnerPid: record.pid,
      expected: record.snapshotId
        ? {
            snapshotId: record.snapshotId,
            sourceRoot: record.sourceRoot,
            workspaceDir: record.workspaceDir,
            buildId: record.buildId,
            runtimeMode: record.runtimeMode ?? "operator",
          }
        : undefined,
      verifyConnectionsApi: record.runtimeMode !== "developer",
    });
    return integrity.ok;
  } catch {
    return false;
  }
}

export async function findReusableRegisteredServer(input: {
  sourceRoot: string;
  workspaceDir: string;
  host?: string;
  port?: number;
  registryRoot?: string;
  snapshotId?: string;
  contentFingerprint?: string;
  runtimeMode?: "operator" | "developer" | "packaged";
}): Promise<ExistingServerMatch | undefined> {
  await cleanupStaleRegistryRecords({ registryRoot: input.registryRoot });
  const identityHash = computeRegistryIdentityHash({
    sourceRoot: input.sourceRoot,
    workspaceDir: input.workspaceDir,
  });
  const records = await listRegistryRecords(input.registryRoot);

  for (const entry of records) {
    const { record } = entry;
    const recordHash = computeRegistryIdentityHash({
      sourceRoot: record.sourceRoot,
      workspaceDir: record.workspaceDir,
    });
    if (recordHash !== identityHash) {
      continue;
    }
    if (
      input.runtimeMode &&
      record.runtimeMode &&
      record.runtimeMode !== input.runtimeMode
    ) {
      continue;
    }
    if (input.snapshotId) {
      if (!record.snapshotId || record.snapshotId !== input.snapshotId) {
        continue;
      }
    }
    if (
      input.contentFingerprint &&
      record.contentFingerprint &&
      record.contentFingerprint !== input.contentFingerprint
    ) {
      continue;
    }
    if (
      input.port !== undefined &&
      (record.port !== input.port ||
        record.host !== resolveGuiHost({ host: input.host }))
    ) {
      continue;
    }
    if (!isProcessAlive(record.pid)) {
      continue;
    }
    if (!(await verifyRegistryRecordHealth(record))) {
      continue;
    }
    return {
      record,
      url: buildUrl(record.host, record.port, "/"),
    };
  }

  return undefined;
}

export async function resolveSourceGuiPort(input: {
  host?: string;
  port?: number;
}): Promise<{ host: string; port: number; requestedPort: number }> {
  const host = resolveGuiHost({ host: input.host });
  const requestedPort = resolveRequestedGuiPort({ host: input.host, port: input.port });

  if (input.port !== undefined) {
    const listeners = await listPortListeners(requestedPort);
    if (listeners.length > 0) {
      throw new Error(
        `Port ${requestedPort} on ${host} is occupied by another process. Free the port or choose a different --port value.`,
      );
    }
    if (!(await isPortAvailable(host, requestedPort))) {
      throw new Error(
        `Port ${requestedPort} on ${host} is occupied by another process. Free the port or choose a different --port value.`,
      );
    }
    return { host, port: requestedPort, requestedPort };
  }

  if (await isPortAvailable(host, DEFAULT_GUI_PORT)) {
    return { host, port: DEFAULT_GUI_PORT, requestedPort: DEFAULT_GUI_PORT };
  }

  const resolution = await resolveAvailableGuiPort({
    host,
    port: DEFAULT_GUI_PORT,
  });
  console.warn(
    `Port ${DEFAULT_GUI_PORT} was busy. Using ${resolution.port} instead.`,
  );
  return resolution;
}

export function registryMatchesWorkspace(
  record: RuntimeRegistryRecord,
  input: { sourceRoot: string; workspaceDir: string },
): boolean {
  return (
    pathsMatch(record.sourceRoot, input.sourceRoot) &&
    pathsMatch(record.workspaceDir, input.workspaceDir)
  );
}
