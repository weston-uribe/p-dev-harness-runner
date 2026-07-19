import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveLocalFilePaths } from "./setup-state.js";
import type { RunnerUpgradeSnapshotSummary } from "./runner-upgrade-types.js";

export const RUNNER_UPGRADE_LAST_VERIFIED_FILE =
  ".harness/p-dev-runner-upgrade.last-verified.json";

export interface RunnerUpgradeLastVerifiedIdentity {
  snapshotContentId: string;
  packageVersion: string;
  sourceCommit: string;
  verifiedAt: string;
  repoSlug?: string;
}

function cacheFilePath(cwd?: string): string {
  const paths = resolveLocalFilePaths(cwd);
  return path.join(paths.harnessDir, "p-dev-runner-upgrade.last-verified.json");
}

export async function readRunnerUpgradeLastVerifiedIdentity(
  cwd?: string,
): Promise<RunnerUpgradeLastVerifiedIdentity | null> {
  try {
    const raw = await readFile(cacheFilePath(cwd), "utf8");
    const parsed = JSON.parse(raw) as RunnerUpgradeLastVerifiedIdentity;
    if (
      typeof parsed.snapshotContentId !== "string" ||
      typeof parsed.packageVersion !== "string" ||
      typeof parsed.sourceCommit !== "string" ||
      typeof parsed.verifiedAt !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function writeRunnerUpgradeLastVerifiedIdentity(
  identity: RunnerUpgradeLastVerifiedIdentity,
  cwd?: string,
): Promise<void> {
  const target = cacheFilePath(cwd);
  await mkdir(path.dirname(target), { recursive: true });
  const tempPath = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(identity, null, 2)}\n`, "utf8");
  await rename(tempPath, target);
}

export function lastVerifiedToSnapshotSummary(
  identity: RunnerUpgradeLastVerifiedIdentity,
): RunnerUpgradeSnapshotSummary {
  return {
    snapshotContentId: identity.snapshotContentId,
    packageVersion: identity.packageVersion,
    sourceCommit: identity.sourceCommit,
  };
}
