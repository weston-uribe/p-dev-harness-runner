import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RuntimeSnapshotIdentity {
  snapshotId: string;
  sourceRoot: string;
  gitHead: string | null;
  contentFingerprint: string;
  createdAt: string;
}

async function tryGitHead(sourceRoot: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "HEAD"],
      { cwd: sourceRoot },
    );
    const head = stdout.trim();
    return /^[0-9a-f]{7,40}$/i.test(head) ? head.toLowerCase() : null;
  } catch {
    return null;
  }
}

async function hashFileIfPresent(
  filePath: string,
): Promise<string | null> {
  try {
    const body = await readFile(filePath);
    return createHash("sha256").update(body).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Stable snapshot identity for operator runtimes.
 * Prefers git HEAD; always mixes package-lock + key package manifests so dirty trees diverge.
 */
export async function computeRuntimeSnapshotIdentity(
  sourceRoot: string,
): Promise<RuntimeSnapshotIdentity> {
  const resolvedRoot = path.resolve(sourceRoot);
  const gitHead = await tryGitHead(resolvedRoot);
  const lockHash = await hashFileIfPresent(
    path.join(resolvedRoot, "package-lock.json"),
  );
  const packageHash = await hashFileIfPresent(
    path.join(resolvedRoot, "package.json"),
  );
  const nextConfigHash = await hashFileIfPresent(
    path.join(resolvedRoot, "apps", "gui", "next.config.ts"),
  );

  const fingerprintPayload = [
    gitHead ?? "no-git",
    lockHash ?? "no-lock",
    packageHash ?? "no-package",
    nextConfigHash ?? "no-next-config",
  ].join("\n");
  const contentFingerprint = createHash("sha256")
    .update(fingerprintPayload)
    .digest("hex");

  // Short, filesystem-safe id; full fingerprint retained in manifests.
  const snapshotId = contentFingerprint.slice(0, 16);

  return {
    snapshotId,
    sourceRoot: resolvedRoot,
    gitHead,
    contentFingerprint,
    createdAt: new Date().toISOString(),
  };
}
