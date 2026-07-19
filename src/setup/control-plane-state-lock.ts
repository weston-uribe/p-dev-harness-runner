import { open, unlink, readFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { resolveLocalFilePaths } from "./setup-state.js";

const LOCK_FILE = "control-plane-setup.lock";
const LOCK_STALE_MS = 30_000;
const LOCK_ACQUIRE_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 50;

export interface ControlPlaneStateLockMetadata {
  ownerId: string;
  claimedAt: string;
}

export interface ControlPlaneStateLockHandle {
  ownerId: string;
  lockPath: string;
  release: () => Promise<void>;
}

function lockPath(cwd?: string): string {
  const paths = resolveLocalFilePaths(cwd);
  return path.join(paths.harnessDir, LOCK_FILE);
}

async function readLockMetadata(
  filePath: string,
): Promise<ControlPlaneStateLockMetadata | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as ControlPlaneStateLockMetadata;
  } catch {
    return null;
  }
}

async function isStaleLock(filePath: string): Promise<boolean> {
  const metadata = await readLockMetadata(filePath);
  if (!metadata?.claimedAt) {
    return true;
  }
  const age = Date.now() - Date.parse(metadata.claimedAt);
  return Number.isNaN(age) || age > LOCK_STALE_MS;
}

export async function acquireControlPlaneStateLock(
  cwd?: string,
): Promise<ControlPlaneStateLockHandle> {
  const paths = resolveLocalFilePaths(cwd);
  await mkdir(paths.harnessDir, { recursive: true });

  const filePath = lockPath(cwd);
  const ownerId = randomUUID();
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const handle = await open(filePath, "wx");
      const metadata: ControlPlaneStateLockMetadata = {
        ownerId,
        claimedAt: new Date().toISOString(),
      };
      await handle.writeFile(JSON.stringify(metadata), "utf8");
      await handle.close();

      return {
        ownerId,
        lockPath: filePath,
        release: async () => {
          const current = await readLockMetadata(filePath);
          if (current?.ownerId === ownerId) {
            await unlink(filePath).catch(() => undefined);
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        if (await isStaleLock(filePath)) {
          await unlink(filePath).catch(() => undefined);
          continue;
        }
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
        continue;
      }
      throw error;
    }
  }

  throw new Error("Timed out waiting for control-plane setup state lock.");
}

export async function withControlPlaneStateLock<T>(
  cwd: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const lock = await acquireControlPlaneStateLock(cwd);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}
