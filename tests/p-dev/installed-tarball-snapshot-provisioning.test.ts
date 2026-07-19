import { execFile, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const packageDir = path.join(repoRoot, "packages", "p-dev");
const execFileAsync = promisify(execFile);
const packagePackLockPath = path.join(os.tmpdir(), "p-dev-package-pack.lockdir");
const GIT_PLUMBING_TEMP_PREFIX = "p-dev-git-plumbing-";

const GENERATED_PACKAGE_OUTPUT_PREFIXES = [
  "packages/p-dev/bin/",
  "packages/p-dev/dist/",
  "packages/p-dev/gui/",
  "packages/p-dev/templates/",
  "packages/p-dev/workspace-snapshot/",
] as const;

function isIgnorableDirtyPackagePath(filePath: string): boolean {
  return GENERATED_PACKAGE_OUTPUT_PREFIXES.some((prefix) =>
    filePath.startsWith(prefix),
  );
}

function isCleanEnoughForPackagePack(): boolean {
  const status = execFileSync("git", ["status", "--porcelain"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return status
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .every((line) => isIgnorableDirtyPackagePath(line.slice(3).trim()));
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquirePackagePackLock(): () => void {
  while (true) {
    try {
      mkdirSync(packagePackLockPath);
      return () => rmSync(packagePackLockPath, { recursive: true, force: true });
    } catch {
      sleepSync(250);
    }
  }
}

function tarballSourceCommit(tarballPath: string): string | null {
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

function packCurrentTarballIfNeeded(): string {
  const packageJson = JSON.parse(
    readFileSync(path.join(packageDir, "package.json"), "utf8"),
  ) as { version: string };
  const nextTarballPath = path.join(
    packageDir,
    `p-dev-harness-${packageJson.version}.tgz`,
  );
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  const releaseLock = acquirePackagePackLock();
  try {
    if (tarballSourceCommit(nextTarballPath) !== head) {
      execFileSync("npm", ["run", "package:p-dev:pack"], {
        cwd: repoRoot,
        stdio: "pipe",
      });
    }
  } finally {
    releaseLock();
  }
  return nextTarballPath;
}

function hasGitAncestor(startDir: string): boolean {
  let current = path.resolve(startDir);
  while (true) {
    if (existsSync(path.join(current, ".git"))) {
      return true;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}

function listPlumbingTempRoots(): string[] {
  return readdirSync(os.tmpdir())
    .filter((name) => name.startsWith(GIT_PLUMBING_TEMP_PREFIX))
    .map((name) => path.join(os.tmpdir(), name));
}

function walkForDotGit(root: string): string[] {
  const found: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.name === ".git") {
        found.push(full);
        continue;
      }
      if (entry.isDirectory()) {
        stack.push(full);
      }
    }
  }
  return found;
}

describe.skipIf(!isCleanEnoughForPackagePack())(
  "installed tarball Step 1 snapshot provisioning outside git worktrees",
  () => {
    let tarballPath = "";
    let installDir = "";
    let packageRoot = "";
    let nonGitSandbox = "";
    const tempDirs: string[] = [];

    beforeAll(async () => {
      tarballPath = packCurrentTarballIfNeeded();
      installDir = await mkdtemp(
        path.join(os.tmpdir(), "p-dev-installed-provision-"),
      );
      tempDirs.push(installDir);
      execFileSync("npm", ["install", "--no-save", `file:${tarballPath}`], {
        cwd: installDir,
        stdio: "pipe",
      });
      packageRoot = path.join(installDir, "node_modules", "p-dev-harness");
      expect(existsSync(packageRoot)).toBe(true);
      expect(path.resolve(packageRoot)).not.toBe(path.resolve(repoRoot));
      expect(existsSync(path.join(packageRoot, ".git"))).toBe(false);

      nonGitSandbox = await mkdtemp(
        path.join(os.tmpdir(), "p-dev-non-git-provision-sandbox-"),
      );
      tempDirs.push(nonGitSandbox);
      expect(hasGitAncestor(nonGitSandbox)).toBe(false);
    }, 180_000);

    afterAll(async () => {
      for (const dir of tempDirs.splice(0).reverse()) {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("provisions the embedded snapshot from a non-git cwd without touching P_DEV_HOME/.git", async () => {
      const home = await mkdtemp(path.join(nonGitSandbox, "home-"));
      const processCwd = await mkdtemp(path.join(nonGitSandbox, "cwd-"));
      expect(hasGitAncestor(processCwd)).toBe(false);
      expect(hasGitAncestor(home)).toBe(false);

      const provisioningPath = path.join(
        packageRoot,
        "dist/setup/harness-repo-provisioning.js",
      );
      const providerPath = path.join(
        packageRoot,
        "dist/setup/github-remote-provider.js",
      );
      const loaderPath = path.join(
        packageRoot,
        "dist/setup/harness-workspace-snapshot-loader.js",
      );
      expect(existsSync(provisioningPath)).toBe(true);
      expect(existsSync(providerPath)).toBe(true);
      expect(existsSync(loaderPath)).toBe(true);

      const scriptPath = path.join(processCwd, "provision-scenario.mjs");
      await writeFile(
        scriptPath,
        `
import { pathToFileURL } from "node:url";
import { readdirSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const provisioningUrl = pathToFileURL(${JSON.stringify(provisioningPath)}).href;
const providerUrl = pathToFileURL(${JSON.stringify(providerPath)}).href;
const loaderUrl = pathToFileURL(${JSON.stringify(loaderPath)}).href;

const { previewHarnessRepoProvisioning, applyHarnessRepoProvisioning } =
  await import(provisioningUrl);
const { MockGitHubHarnessProvisioningProvider } = await import(providerUrl);
const { loadEmbeddedWorkspaceSnapshot } = await import(loaderUrl);

const beforePlumbing = new Set(
  readdirSync(os.tmpdir())
    .filter((name) => name.startsWith("p-dev-git-plumbing-"))
    .map((name) => path.join(os.tmpdir(), name)),
);

const provider = new MockGitHubHarnessProvisioningProvider({
  authenticatedUser: { id: 1, login: "packaged-user" },
});

const preview = await previewHarnessRepoProvisioning({
  cwd: process.env.P_DEV_HOME,
  provider,
  operationId: "op-packaged-non-git",
});

const apply = await applyHarnessRepoProvisioning({
  cwd: process.env.P_DEV_HOME,
  provider,
  confirmed: true,
  fingerprint: preview.fingerprint,
  operationId: preview.operationId,
});

await provider.dispose();

const snapshot = await loadEmbeddedWorkspaceSnapshot(undefined, process.env);
const afterPlumbing = readdirSync(os.tmpdir())
  .filter((name) => name.startsWith("p-dev-git-plumbing-"))
  .map((name) => path.join(os.tmpdir(), name))
  .filter((root) => !beforePlumbing.has(root));

console.log(JSON.stringify({
  previewState: preview.state,
  applyState: apply.state,
  applyMessage: apply.message,
  harnessDispatchRepo: apply.harnessDispatchRepo,
  snapshotOk: snapshot.ok,
  manifestTreeSha: snapshot.ok ? snapshot.manifest.gitRootTreeSha1 : null,
  packageRoot: snapshot.ok ? snapshot.packageRoot : null,
  leftoverPlumbing: afterPlumbing,
  homeHasDotGit: existsSync(path.join(process.env.P_DEV_HOME, ".git")),
  cwdHasDotGit: existsSync(path.join(process.cwd(), ".git")),
}));
`,
        "utf8",
      );

      const beforePlumbing = new Set(listPlumbingTempRoots());
      void beforePlumbing;
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const key of [
        "VITEST",
        "CI",
        "GITHUB_ACTIONS",
        "VERCEL",
        "P_DEV_OBSERVABILITY_SESSION_ID",
        "P_DEV_OBSERVABILITY_NONCE",
        "DO_NOT_TRACK",
        "P_DEV_OBSERVABILITY_DISABLED",
        "P_DEV_ANALYTICS_DISABLED",
        "P_DEV_SENTRY_DISABLED",
      ]) {
        delete env[key];
      }
      env.NODE_ENV = "production";
      env.P_DEV_RUNTIME_MODE = "packaged";
      env.P_DEV_PACKAGE_ROOT = packageRoot;
      env.P_DEV_PACKAGE_VERSION = JSON.parse(
        readFileSync(path.join(packageRoot, "package.json"), "utf8"),
      ).version;
      env.P_DEV_HOME = home;
      env.HARNESS_REPO_ROOT = home;

      const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath], {
        cwd: processCwd,
        env,
        timeout: 240_000,
        maxBuffer: 4 * 1024 * 1024,
      }).catch((error: Error & { stdout?: string; stderr?: string }) => {
        throw new Error(
          `provision scenario failed: ${error.message}\nstdout=${error.stdout ?? ""}\nstderr=${error.stderr ?? ""}`,
        );
      });
      void stderr;      const output = JSON.parse(
        stdout.trim().split("\n").at(-1) ?? "{}",
      ) as {
        previewState?: string;
        applyState?: string;
        harnessDispatchRepo?: string;
        snapshotOk?: boolean;
        manifestTreeSha?: string;
        packageRoot?: string;
        leftoverPlumbing?: string[];
        homeHasDotGit?: boolean;
        cwdHasDotGit?: boolean;
      };

      expect(output.snapshotOk).toBe(true);
      expect(output.packageRoot).toBe(packageRoot);
      expect(output.packageRoot).not.toBe(repoRoot);
      expect(output.previewState).toBe("repo-absent");
      expect(
        {
          state: output.applyState,
          message: output.applyMessage,
        },
        "packaged Step 1 apply must reach verified-and-persisted",
      ).toEqual({
        state: "verified-and-persisted",
        message: expect.any(String),
      });
      expect(output.harnessDispatchRepo).toBe("packaged-user/p-dev-harness");
      expect(output.manifestTreeSha).toMatch(/^[0-9a-f]{40}$/);
      expect(output.homeHasDotGit).toBe(false);
      expect(output.cwdHasDotGit).toBe(false);
      expect(output.leftoverPlumbing ?? []).toEqual([]);
      expect(walkForDotGit(home)).toEqual([]);
      expect(hasGitAncestor(processCwd)).toBe(false);

      const envLocal = readFileSync(path.join(home, ".env.local"), "utf8");
      expect(envLocal).toContain(
        "GITHUB_DISPATCH_REPOSITORY=packaged-user/p-dev-harness",
      );

      // Packaging worktree must remain unused as process cwd / package root.
      expect(statSync(packageRoot).isDirectory()).toBe(true);
      expect(path.resolve(processCwd)).not.toBe(path.resolve(repoRoot));
    }, 300_000);
  },
);
