import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

export const REGISTRY_SCHEMA_VERSION = 1;
export const REGISTRY_DIR_NAME = "p-dev/gui-servers";
export const REGISTRY_STALE_MS = 24 * 60 * 60 * 1000;

export interface RuntimeRegistryRecord {
  schemaVersion: number;
  instanceId: string;
  sourceRoot: string;
  workspaceDir: string;
  host: string;
  port: number;
  pid: number;
  startedAt: string;
  sourceCommit?: string;
  /** Operator snapshot identity; required for operator-mode reuse. */
  snapshotId?: string;
  buildId?: string;
  runtimeMode?: "operator" | "developer" | "packaged";
  runtimeDir?: string;
  contentFingerprint?: string;
}

export interface RuntimeRegistryOptions {
  registryRoot?: string;
  now?: () => number;
}

function normalizePath(value: string): string {
  return path.resolve(value);
}

export function computeRegistryIdentityHash(input: {
  sourceRoot: string;
  workspaceDir: string;
}): string {
  const payload = `${normalizePath(input.sourceRoot)}\n${normalizePath(input.workspaceDir)}`;
  return createHash("sha256").update(payload).digest("hex");
}

export function resolveRegistryDirectory(registryRoot = tmpdir()): string {
  return path.join(registryRoot, REGISTRY_DIR_NAME);
}

export function resolveRegistryRecordPath(input: {
  sourceRoot: string;
  workspaceDir: string;
  registryRoot?: string;
}): string {
  const identityHash = computeRegistryIdentityHash(input);
  return path.join(
    resolveRegistryDirectory(input.registryRoot),
    `${identityHash}.json`,
  );
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isRegistryRecordStale(
  record: RuntimeRegistryRecord,
  now = Date.now(),
): boolean {
  const startedAt = Date.parse(record.startedAt);
  if (!Number.isFinite(startedAt)) {
    return true;
  }
  if (now - startedAt > REGISTRY_STALE_MS) {
    return true;
  }
  return !isProcessAlive(record.pid);
}

export async function writeRegistryRecord(
  record: RuntimeRegistryRecord,
  options?: RuntimeRegistryOptions,
): Promise<string> {
  const recordPath = resolveRegistryRecordPath({
    sourceRoot: record.sourceRoot,
    workspaceDir: record.workspaceDir,
    registryRoot: options?.registryRoot,
  });
  await mkdir(path.dirname(recordPath), { recursive: true });
  const tempPath = `${recordPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(record)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tempPath, recordPath);
  return recordPath;
}

export async function readRegistryRecord(
  recordPath: string,
): Promise<RuntimeRegistryRecord | undefined> {
  try {
    const raw = await readFile(recordPath, "utf8");
    return JSON.parse(raw) as RuntimeRegistryRecord;
  } catch {
    return undefined;
  }
}

export async function removeRegistryRecord(input: {
  sourceRoot: string;
  workspaceDir: string;
  instanceId: string;
  registryRoot?: string;
}): Promise<boolean> {
  const recordPath = resolveRegistryRecordPath(input);
  const record = await readRegistryRecord(recordPath);
  if (!record) {
    return false;
  }
  if (record.instanceId !== input.instanceId) {
    return false;
  }
  await rm(recordPath, { force: true });
  return true;
}

export async function listRegistryRecords(
  registryRoot?: string,
): Promise<Array<{ recordPath: string; record: RuntimeRegistryRecord }>> {
  const directory = resolveRegistryDirectory(registryRoot);
  let entries: string[] = [];
  try {
    entries = await readdir(directory);
  } catch {
    return [];
  }

  const records: Array<{ recordPath: string; record: RuntimeRegistryRecord }> =
    [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const recordPath = path.join(directory, entry);
    const record = await readRegistryRecord(recordPath);
    if (record) {
      records.push({ recordPath, record });
    }
  }
  return records;
}

export async function cleanupStaleRegistryRecords(
  options?: RuntimeRegistryOptions,
): Promise<number> {
  const now = options?.now?.() ?? Date.now();
  const records = await listRegistryRecords(options?.registryRoot);
  let removed = 0;
  for (const entry of records) {
    if (!isRegistryRecordStale(entry.record, now)) {
      continue;
    }
    await rm(entry.recordPath, { force: true });
    removed += 1;
  }
  return removed;
}

export function createRegistryRecord(input: {
  sourceRoot: string;
  workspaceDir: string;
  host: string;
  port: number;
  pid: number;
  sourceCommit?: string;
  instanceId?: string;
  snapshotId?: string;
  buildId?: string;
  runtimeMode?: "operator" | "developer" | "packaged";
  runtimeDir?: string;
  contentFingerprint?: string;
}): RuntimeRegistryRecord {
  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    instanceId: input.instanceId ?? randomUUID(),
    sourceRoot: normalizePath(input.sourceRoot),
    workspaceDir: normalizePath(input.workspaceDir),
    host: input.host,
    port: input.port,
    pid: input.pid,
    startedAt: new Date().toISOString(),
    sourceCommit: input.sourceCommit,
    snapshotId: input.snapshotId,
    buildId: input.buildId,
    runtimeMode: input.runtimeMode,
    runtimeDir: input.runtimeDir
      ? normalizePath(input.runtimeDir)
      : undefined,
    contentFingerprint: input.contentFingerprint,
  };
}

export async function updateRegistryPid(input: {
  sourceRoot: string;
  workspaceDir: string;
  instanceId: string;
  pid: number;
  registryRoot?: string;
}): Promise<void> {
  const recordPath = resolveRegistryRecordPath(input);
  const record = await readRegistryRecord(recordPath);
  if (!record || record.instanceId !== input.instanceId) {
    throw new Error("Registry record not found for launcher instance.");
  }
  await writeRegistryRecord(
    {
      ...record,
      pid: input.pid,
      startedAt: new Date().toISOString(),
    },
    { registryRoot: input.registryRoot },
  );
}
