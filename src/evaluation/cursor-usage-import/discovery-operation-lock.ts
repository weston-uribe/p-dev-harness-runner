import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { CURSOR_USAGE_DISCOVERY_ALGORITHM_VERSION } from "./discovery-constants.js";

/**
 * process_local_single_flight with optional workspace-scoped advisory FS lease.
 * Lock identity excludes the query window so different windows on the same
 * target cannot overlap.
 */
export type DiscoveryLockIdentityInput = {
  workspaceIdentity: string;
  langfuseProjectScopeDigest: string;
  canonicalEndpointIdentity: string;
  namespace: string;
  environmentFilter: string | null;
  algorithmVersion?: string;
};

export type DiscoveryLockHandle = {
  lockKeyHash: string;
  operationId: string;
  /** Diagnostics only — not part of exclusivity key. */
  activeWindow?: {
    observationFromStartTime: string;
    observationToStartTime: string;
  };
  release: () => Promise<void>;
};

const processLocks = new Map<
  string,
  {
    operationId: string;
    ownerPid: number;
    activeWindow?: DiscoveryLockHandle["activeWindow"];
    settled: Promise<void>;
    resolveSettled: () => void;
  }
>();

function lockKeyHash(input: DiscoveryLockIdentityInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        workspaceIdentity: input.workspaceIdentity,
        langfuseProjectScopeDigest: input.langfuseProjectScopeDigest,
        canonicalEndpointIdentity: input.canonicalEndpointIdentity,
        namespace: input.namespace,
        environmentFilter: input.environmentFilter,
        algorithmVersion:
          input.algorithmVersion ?? CURSOR_USAGE_DISCOVERY_ALGORITHM_VERSION,
      }),
    )
    .digest("hex");
}

function leasePath(logDirectory: string, keyHash: string): string {
  return path.join(
    logDirectory,
    "evaluation-reports",
    "cursor-usage-imports",
    "locks",
    "discovery",
    `${keyHash}.lease`,
  );
}

async function tryAcquireFsLease(
  logDirectory: string,
  keyHash: string,
  operationId: string,
): Promise<{ release: () => Promise<void> } | null> {
  const filePath = leasePath(logDirectory, keyHash);
  await mkdir(path.dirname(filePath), { recursive: true });
  try {
    const handle = await open(filePath, "wx");
    await handle.writeFile(
      JSON.stringify({
        operationId,
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
      }),
      "utf8",
    );
    await handle.close();
    return {
      release: async () => {
        await unlink(filePath).catch(() => undefined);
      },
    };
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? (error as { code?: string }).code
        : null;
    if (code === "EEXIST") {
      // Stale lease from dead PID may be cleared.
      try {
        const raw = await readFile(filePath, "utf8");
        const parsed = JSON.parse(raw) as { pid?: number };
        if (
          typeof parsed.pid === "number" &&
          parsed.pid !== process.pid
        ) {
          try {
            process.kill(parsed.pid, 0);
            return null; // still alive
          } catch {
            await unlink(filePath).catch(() => undefined);
            return tryAcquireFsLease(logDirectory, keyHash, operationId);
          }
        }
      } catch {
        return null;
      }
      return null;
    }
    throw error;
  }
}

export class DiscoveryAlreadyRunningError extends Error {
  readonly code = "cursor_usage_discovery_already_running" as const;
  constructor(message = "A Cursor usage discovery operation is already running for this target.") {
    super(message);
    this.name = "DiscoveryAlreadyRunningError";
  }
}

export async function acquireDiscoveryLock(params: {
  identity: DiscoveryLockIdentityInput;
  logDirectory: string;
  operationId?: string;
  activeWindow?: DiscoveryLockHandle["activeWindow"];
}): Promise<DiscoveryLockHandle> {
  const key = lockKeyHash(params.identity);
  if (processLocks.has(key)) {
    throw new DiscoveryAlreadyRunningError();
  }

  const operationId = params.operationId ?? randomUUID();
  let resolveSettled!: () => void;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });

  const fsLease = await tryAcquireFsLease(
    params.logDirectory,
    key,
    operationId,
  );
  if (!fsLease) {
    throw new DiscoveryAlreadyRunningError();
  }

  processLocks.set(key, {
    operationId,
    ownerPid: process.pid,
    activeWindow: params.activeWindow,
    settled,
    resolveSettled,
  });

  let released = false;
  return {
    lockKeyHash: key,
    operationId,
    activeWindow: params.activeWindow,
    release: async () => {
      if (released) return;
      released = true;
      processLocks.delete(key);
      resolveSettled();
      await fsLease.release();
    },
  };
}

export function getActiveDiscoveryLockWindow(
  identity: DiscoveryLockIdentityInput,
): DiscoveryLockHandle["activeWindow"] | null {
  const entry = processLocks.get(lockKeyHash(identity));
  return entry?.activeWindow ?? null;
}

/** Test helper — clear process-local locks (does not unlink FS leases). */
export function resetDiscoveryLocksForTests(): void {
  for (const entry of processLocks.values()) {
    entry.resolveSettled();
  }
  processLocks.clear();
}

export function discoveryLockKeyHashForTests(
  identity: DiscoveryLockIdentityInput,
): string {
  return lockKeyHash(identity);
}
