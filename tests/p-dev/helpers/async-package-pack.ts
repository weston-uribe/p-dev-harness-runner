/**
 * Async package-pack helpers for installed-tarball suites.
 *
 * Vitest's worker↔main birpc channel uses a 60s timeout. Synchronous
 * `execFileSync("npm", ["run", "package:p-dev:pack"])` (often 2–3+ minutes)
 * blocks the worker event loop and surfaces as:
 *   [vitest-worker]: Timeout calling "onTaskUpdate"
 * even when every assertion passed. Keep long npm work on the event loop.
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packagePackLockPath = path.join(os.tmpdir(), "p-dev-package-pack.lockdir");

function sleepAsync(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function acquirePackagePackLockAsync(): Promise<() => void> {
  while (true) {
    try {
      mkdirSync(packagePackLockPath);
      return () => rmSync(packagePackLockPath, { recursive: true, force: true });
    } catch {
      await sleepAsync(250);
    }
  }
}

export function tarballSourceCommit(tarballPath: string): string | null {
  if (!existsSync(tarballPath)) {
    return null;
  }
  try {
    const raw = execFileSync(
      "tar",
      ["-xOf", tarballPath, "package/workspace-snapshot/manifest.json"],
      { encoding: "utf8" },
    );
    return (JSON.parse(raw) as { sourceCommit?: string }).sourceCommit ?? null;
  } catch {
    return null;
  }
}

export async function packCurrentTarballIfNeededAsync(options: {
  repoRoot: string;
  packageDir: string;
}): Promise<string> {
  const packageJson = JSON.parse(
    readFileSync(path.join(options.packageDir, "package.json"), "utf8"),
  ) as { version: string };
  const nextTarballPath = path.join(
    options.packageDir,
    `p-dev-harness-${packageJson.version}.tgz`,
  );
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: options.repoRoot,
    encoding: "utf8",
  }).trim();
  const releaseLock = await acquirePackagePackLockAsync();
  try {
    if (tarballSourceCommit(nextTarballPath) !== head) {
      await execFileAsync("npm", ["run", "package:p-dev:pack"], {
        cwd: options.repoRoot,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
    }
  } finally {
    releaseLock();
  }
  return nextTarballPath;
}

export async function npmInstallTarballAsync(options: {
  installDir: string;
  tarballPath: string;
}): Promise<void> {
  await execFileAsync(
    "npm",
    ["install", "--no-save", `file:${options.tarballPath}`],
    {
      cwd: options.installDir,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
}
