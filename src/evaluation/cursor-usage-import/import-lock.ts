import { createHash } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { SCORE_CONTRACT_VERSION } from "./canonical.js";
import { CURSOR_USAGE_IMPORTER_VERSION } from "./types.js";
import type { ExportWindow } from "./canonical.js";
import type { CanonicalSourceType } from "./canonical.js";

const LOCK_SUBDIR = "evaluation-reports/cursor-usage-imports/locks";
const DEFAULT_LOCK_TTL_MS = 30 * 60 * 1000;
const LOCK_ACQUIRE_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 50;

export interface CanonicalImportIdentityInput {
  namespace: string;
  environment?: string | null;
  sourceType: CanonicalSourceType;
  sourceDigestOrQueryIdentity: string;
  normalizedFilters?: Record<string, unknown> | null;
  exportWindow: ExportWindow | null;
  importerVersion?: string;
  scoreContractVersion?: string;
}

export interface ImportLockMetadata {
  importId: string;
  acquiredAt: string;
  expiresAt: string;
  canonicalImportIdentity: string;
}

export interface ImportLockHandle {
  importId: string;
  lockPath: string;
  release: () => Promise<void>;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

export function canonicalImportIdentity(
  input: CanonicalImportIdentityInput,
): string {
  const payload = {
    namespace: input.namespace.trim(),
    environment: input.environment?.trim() || null,
    sourceType: input.sourceType,
    sourceDigestOrQueryIdentity: input.sourceDigestOrQueryIdentity,
    normalizedFilters: input.normalizedFilters ?? null,
    exportWindow: input.exportWindow,
    importerVersion: input.importerVersion ?? CURSOR_USAGE_IMPORTER_VERSION,
    scoreContractVersion: input.scoreContractVersion ?? SCORE_CONTRACT_VERSION,
  };
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

function locksRoot(logDirectory: string): string {
  return path.join(logDirectory, LOCK_SUBDIR);
}

function lockFilePath(logDirectory: string, identity: string): string {
  return path.join(locksRoot(logDirectory), `${identity}.lock`);
}

function traceLockPath(logDirectory: string, traceId: string): string {
  return path.join(locksRoot(logDirectory), "traces", `${traceId}.lock`);
}

async function readLockMetadata(
  filePath: string,
): Promise<ImportLockMetadata | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as ImportLockMetadata;
  } catch {
    return null;
  }
}

function isStaleLock(metadata: ImportLockMetadata | null): boolean {
  if (!metadata?.expiresAt) return true;
  const expires = Date.parse(metadata.expiresAt);
  return Number.isNaN(expires) || Date.now() >= expires;
}

export async function acquireImportLock(params: {
  logDirectory: string;
  importId: string;
  identity: CanonicalImportIdentityInput;
  ttlMs?: number;
  traceIds?: string[];
}): Promise<ImportLockHandle> {
  const identityHash = canonicalImportIdentity(params.identity);
  await mkdir(locksRoot(params.logDirectory), { recursive: true });
  await mkdir(path.join(locksRoot(params.logDirectory), "traces"), {
    recursive: true,
  });

  const filePath = lockFilePath(params.logDirectory, identityHash);
  const acquiredAt = new Date().toISOString();
  const expiresAt = new Date(
    Date.now() + (params.ttlMs ?? DEFAULT_LOCK_TTL_MS),
  ).toISOString();
  const metadata: ImportLockMetadata = {
    importId: params.importId,
    acquiredAt,
    expiresAt,
    canonicalImportIdentity: identityHash,
  };

  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const handle = await open(filePath, "wx");
      await handle.writeFile(JSON.stringify(metadata, null, 2), "utf8");
      await handle.close();

      const traceHandles: string[] = [];
      for (const traceId of params.traceIds ?? []) {
        const tPath = traceLockPath(params.logDirectory, traceId);
        try {
          const th = await open(tPath, "wx");
          await th.writeFile(
            JSON.stringify({ importId: params.importId, traceId, acquiredAt }),
            "utf8",
          );
          await th.close();
          traceHandles.push(tPath);
        } catch (err) {
          for (const p of traceHandles) {
            await unlink(p).catch(() => undefined);
          }
          await unlink(filePath).catch(() => undefined);
          if ((err as NodeJS.ErrnoException).code === "EEXIST") {
            throw new Error(`trace_lock_held:${traceId}`);
          }
          throw err;
        }
      }

      return {
        importId: params.importId,
        lockPath: filePath,
        release: async () => {
          const current = await readLockMetadata(filePath);
          if (current?.importId === params.importId) {
            await unlink(filePath).catch(() => undefined);
          }
          for (const traceId of params.traceIds ?? []) {
            await unlink(traceLockPath(params.logDirectory, traceId)).catch(
              () => undefined,
            );
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const current = await readLockMetadata(filePath);
        if (isStaleLock(current)) {
          await unlink(filePath).catch(() => undefined);
          continue;
        }
        if (current?.importId === params.importId) {
          return {
            importId: params.importId,
            lockPath: filePath,
            release: async () => {
              const again = await readLockMetadata(filePath);
              if (again?.importId === params.importId) {
                await unlink(filePath).catch(() => undefined);
              }
            },
          };
        }
        await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
        continue;
      }
      throw error;
    }
  }

  throw new Error("Timed out waiting for cursor usage import lock.");
}

export async function releaseImportLock(
  logDirectory: string,
  importId: string,
): Promise<void> {
  const root = locksRoot(logDirectory);
  let entries: string[];
  try {
    const { readdir } = await import("node:fs/promises");
    entries = await readdir(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".lock")) continue;
    const filePath = path.join(root, entry);
    const meta = await readLockMetadata(filePath);
    if (meta?.importId === importId) {
      await unlink(filePath).catch(() => undefined);
    }
  }
}

export async function withImportLock<T>(
  params: {
    logDirectory: string;
    importId: string;
    identity: CanonicalImportIdentityInput;
    ttlMs?: number;
    traceIds?: string[];
  },
  fn: () => Promise<T>,
): Promise<T> {
  const lock = await acquireImportLock(params);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}
