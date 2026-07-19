import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createGitAskpassCredentials,
  GIT_ASKPASS_TEMP_PREFIX,
} from "../../src/setup/git-askpass-credentials.js";
import {
  buildHarnessSnapshotPushArgs,
  HARNESS_PROVISION_GIT_TEMP_PREFIX,
  HARNESS_SNAPSHOT_GIT_HTTP_POST_BUFFER_BYTES,
  pushHarnessSnapshotViaLocalBareGit,
} from "../../src/setup/harness-snapshot-git-transport.js";
import { HARNESS_MANAGED_REPO_MARKER_FILE } from "../../src/setup/harness-managed-repo-marker.js";
import { SnapshotProvisioningError } from "../../src/setup/harness-snapshot-provisioning-helpers.js";
import type { WorkspaceSnapshotManifest } from "../../src/p-dev/workspace-snapshot-types.js";
import { createRepresentativeBulkSnapshotFixture } from "./harness-snapshot-bulk-fixture.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const embeddedSnapshotRoot = path.join(
  repoRoot,
  "packages/p-dev/workspace-snapshot",
);

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function trackTemp(dir: string): string {
  tempDirs.push(dir);
  return dir;
}

function loadEmbeddedManifest(): {
  snapshotRoot: string;
  manifest: WorkspaceSnapshotManifest;
} {
  const manifestPath = path.join(embeddedSnapshotRoot, "manifest.json");
  expect(existsSync(manifestPath)).toBe(true);
  const manifest = JSON.parse(
    readFileSync(manifestPath, "utf8"),
  ) as WorkspaceSnapshotManifest;
  expect(manifest.fileCount).toBeGreaterThan(100);
  return { snapshotRoot: embeddedSnapshotRoot, manifest };
}

function createInitializedBareRemote(defaultBranch = "main"): {
  barePath: string;
  initializedCommitSha: string;
  defaultBranch: string;
} {
  const seed = trackTemp(mkdtempSync(path.join(tmpdir(), "p-dev-seed-repo-")));
  const barePath = trackTemp(mkdtempSync(path.join(tmpdir(), "p-dev-bare-remote-")));
  const init = spawnSync("git", ["init", "-b", defaultBranch], { cwd: seed });
  expect(init.status).toBe(0);
  writeFileSync(path.join(seed, "README.md"), "# p-dev\n", "utf8");
  expect(spawnSync("git", ["add", "."], { cwd: seed }).status).toBe(0);
  expect(
    spawnSync(
      "git",
      ["-c", "user.email=test@p-dev.local", "-c", "user.name=p-dev-test", "commit", "-m", "Initial commit"],
      { cwd: seed },
    ).status,
  ).toBe(0);
  const head = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: seed,
    encoding: "utf8",
  }).stdout.trim();
  rmSync(barePath, { recursive: true, force: true });
  expect(
    spawnSync("git", ["clone", "--bare", seed, barePath], { encoding: "utf8" })
      .status,
  ).toBe(0);
  return { barePath, initializedCommitSha: head, defaultBranch };
}

function gitInBare(barePath: string, args: string[]): string {
  const result = spawnSync("git", ["--git-dir", barePath, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args[0]} failed`);
  }
  return result.stdout.trim();
}

function readBarePackSizeBytes(barePath: string): number | undefined {
  const packDir = path.join(barePath, "objects", "pack");
  if (!existsSync(packDir)) {
    return undefined;
  }
  const packFiles = readdirSync(packDir).filter((name) => name.endsWith(".pack"));
  if (packFiles.length === 0) {
    return undefined;
  }
  return packFiles.reduce(
    (total, name) => total + statSync(path.join(packDir, name)).size,
    0,
  );
}

function listTempPrefix(prefix: string): string[] {
  return readdirSync(tmpdir())
    .filter((name) => name.startsWith(prefix))
    .map((name) => path.join(tmpdir(), name));
}

describe("harness snapshot bulk git transport", () => {
  it(
    "pushes the embedded snapshot once to a local bare remote with exact tree SHA and modes",
    async () => {
      const { snapshotRoot, manifest } = loadEmbeddedManifest();
      const remote = createInitializedBareRemote();
      const capture = { argv: [] as string[][], stdout: [] as string[], stderr: [] as string[] };
      const operationId = "op-bulk-bare-1";
      const beforeProvisionTemps = new Set(listTempPrefix(HARNESS_PROVISION_GIT_TEMP_PREFIX));
      const beforeAskpassTemps = new Set(listTempPrefix(GIT_ASKPASS_TEMP_PREFIX));

      const started = Date.now();
      const result = await pushHarnessSnapshotViaLocalBareGit({
        bareRemotePath: remote.barePath,
        defaultBranch: remote.defaultBranch,
        expectedHeadSha: remote.initializedCommitSha,
        initializedCommitSha: remote.initializedCommitSha,
        snapshotRoot,
        manifest,
        operationId,
        packageVersion: manifest.packageVersion,
        capture,
        buildMarkerContent: (snapshotCommitSha) =>
          `${JSON.stringify(
            {
              schemaVersion: 1,
              role: "managed-harness-workspace",
              snapshotCommitSha,
              operationId,
            },
            null,
            2,
          )}\n`,
      });
      const durationMs = Date.now() - started;
      const packSizeBytes = readBarePackSizeBytes(remote.barePath);

      expect(result.pushCount).toBe(1);
      expect(result.snapshotGitTreeSha1).toBe(manifest.gitRootTreeSha1);
      expect(result.tempRootRemoved).toBe(true);
      expect(result.askpassRemoved).toBe(true);

      const head = gitInBare(remote.barePath, ["rev-parse", remote.defaultBranch]);
      expect(head).toBe(result.markerCommitSha);

      const markerParent = gitInBare(remote.barePath, [
        "rev-parse",
        `${result.markerCommitSha}^`,
      ]);
      expect(markerParent).toBe(result.snapshotCommitSha);

      const snapshotParent = gitInBare(remote.barePath, [
        "rev-parse",
        `${result.snapshotCommitSha}^`,
      ]);
      expect(snapshotParent).toBe(remote.initializedCommitSha);

      const snapshotTree = gitInBare(remote.barePath, [
        "rev-parse",
        `${result.snapshotCommitSha}^{tree}`,
      ]);
      expect(snapshotTree).toBe(manifest.gitRootTreeSha1);

      // Spot-check exact bytes + executable mode preservation for a few files.
      const sampleFiles = manifest.files.slice(0, 5);
      for (const file of sampleFiles) {
        const remoteBytes = Buffer.from(
          gitInBare(remote.barePath, [
            "cat-file",
            "-p",
            `${result.snapshotCommitSha}:${file.path}`,
          ]),
          // cat-file -p for binary may not be utf8; use spawn buffer instead below
        );
        void remoteBytes;
      }
      for (const file of sampleFiles) {
        const cat = spawnSync(
          "git",
          ["--git-dir", remote.barePath, "cat-file", "-p", `${result.snapshotCommitSha}:${file.path}`],
          { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
        );
        expect(cat.status).toBe(0);
        const expected = readFileSync(path.join(snapshotRoot, "files", file.path));
        expect(Buffer.compare(cat.stdout as Buffer, expected)).toBe(0);
        const ls = gitInBare(remote.barePath, [
          "ls-tree",
          result.snapshotCommitSha,
          "--",
          file.path,
        ]);
        expect(ls.startsWith(file.mode)).toBe(true);
      }

      const markerPresent = gitInBare(remote.barePath, [
        "cat-file",
        "-e",
        `${result.markerCommitSha}:${HARNESS_MANAGED_REPO_MARKER_FILE}`,
      ]);
      expect(markerPresent).toBe("");

      const pushArgv = capture.argv.filter((args) => args.includes("push"));
      expect(pushArgv.length).toBe(1);
      expect(pushArgv[0]).toEqual([
        "git",
        ...buildHarnessSnapshotPushArgs(
          result.markerCommitSha,
          remote.defaultBranch,
        ),
      ]);
      expect(pushArgv[0]).toContain("-c");
      expect(pushArgv[0]).toContain(
        `http.postBuffer=${HARNESS_SNAPSHOT_GIT_HTTP_POST_BUFFER_BYTES}`,
      );
      expect(pushArgv[0]).toContain("--atomic");
      const blobMutations = capture.argv.filter(
        (args) => args.includes("hash-object") === false && args.join(" ").includes("createGitBlob"),
      );
      expect(blobMutations.length).toBe(0);

      const leftoverProvision = listTempPrefix(HARNESS_PROVISION_GIT_TEMP_PREFIX).filter(
        (root) => !beforeProvisionTemps.has(root),
      );
      const leftoverAskpass = listTempPrefix(GIT_ASKPASS_TEMP_PREFIX).filter(
        (root) => !beforeAskpassTemps.has(root),
      );
      expect(leftoverProvision).toEqual([]);
      expect(leftoverAskpass).toEqual([]);

      // Hard-gate signal for the final report.
      console.log(
        JSON.stringify({
          hardGate: "bulk-local-bare",
          fileCount: manifest.fileCount,
          objectCount: manifest.files.length,
          pushCount: result.pushCount,
          durationMs,
          transportTimingsMs: result.timings,
          packSizeBytes,
          verification: {
            branchHeadMatchesMarker: head === result.markerCommitSha,
            markerParentMatchesSnapshot: markerParent === result.snapshotCommitSha,
            snapshotParentMatchesInitial:
              snapshotParent === remote.initializedCommitSha,
            snapshotTreeMatchesManifest:
              snapshotTree === manifest.gitRootTreeSha1,
            markerFilePresent: markerPresent === "",
            sampleFilesVerified: sampleFiles.length,
            tempProvisionClean: leftoverProvision.length === 0,
            tempAskpassClean: leftoverAskpass.length === 0,
          },
          snapshotTree: result.snapshotGitTreeSha1,
        }),
      );
      expect(durationMs).toBeLessThan(180_000);
    },
    240_000,
  );

  it("builds push argv with http.postBuffer above the default 1 MiB for large snapshot packs", () => {
    const args = buildHarnessSnapshotPushArgs(
      "abc123def456",
      "main",
    );
    expect(args).toEqual([
      "-c",
      `http.postBuffer=${HARNESS_SNAPSHOT_GIT_HTTP_POST_BUFFER_BYTES}`,
      "push",
      "--atomic",
      "origin",
      "abc123def456:refs/heads/main",
    ]);
    expect(HARNESS_SNAPSHOT_GIT_HTTP_POST_BUFFER_BYTES).toBeGreaterThan(1_048_576);
    // No force, no token/userinfo in argv.
    expect(args.join(" ")).not.toMatch(/--force|-f\b|x-access-token|@/);
  });

  it("removes temp git data on failure and rejects unexpected remote HEAD without force", async () => {
    const fixture = await createRepresentativeBulkSnapshotFixture(48);
    trackTemp(fixture.packageRoot);
    const remote = createInitializedBareRemote();
    const foreign = trackTemp(mkdtempSync(path.join(tmpdir(), "p-dev-foreign-")));
    spawnSync("git", ["clone", remote.barePath, foreign], { encoding: "utf8" });
    writeFileSync(path.join(foreign, "EXTRA.md"), "nope\n", "utf8");
    spawnSync("git", ["add", "."], { cwd: foreign });
    spawnSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "foreign"],
      { cwd: foreign },
    );
    spawnSync("git", ["push", "origin", "HEAD"], { cwd: foreign });
    const unexpectedHead = gitInBare(remote.barePath, ["rev-parse", remote.defaultBranch]);
    expect(unexpectedHead).not.toBe(remote.initializedCommitSha);

    const beforeTemps = new Set(listTempPrefix(HARNESS_PROVISION_GIT_TEMP_PREFIX));
    await expect(
      pushHarnessSnapshotViaLocalBareGit({
        bareRemotePath: remote.barePath,
        defaultBranch: remote.defaultBranch,
        expectedHeadSha: remote.initializedCommitSha,
        initializedCommitSha: remote.initializedCommitSha,
        snapshotRoot: fixture.snapshotRoot,
        manifest: fixture.manifest,
        operationId: "op-conflict",
        packageVersion: fixture.manifest.packageVersion,
        buildMarkerContent: (sha) => `${sha}\n`,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof SnapshotProvisioningError &&
        error.code === "ref-update-unexpected-head"
      );
    });

    const leftover = listTempPrefix(HARNESS_PROVISION_GIT_TEMP_PREFIX).filter(
      (root) => !beforeTemps.has(root),
    );
    expect(leftover).toEqual([]);
  }, 60_000);

  it("is idempotent when marker is already present (retry after success)", async () => {
    const fixture = await createRepresentativeBulkSnapshotFixture(48);
    trackTemp(fixture.packageRoot);
    const remote = createInitializedBareRemote();
    const first = await pushHarnessSnapshotViaLocalBareGit({
      bareRemotePath: remote.barePath,
      defaultBranch: remote.defaultBranch,
      expectedHeadSha: remote.initializedCommitSha,
      initializedCommitSha: remote.initializedCommitSha,
      snapshotRoot: fixture.snapshotRoot,
      manifest: fixture.manifest,
      operationId: "op-idempotent",
      packageVersion: fixture.manifest.packageVersion,
      buildMarkerContent: (sha) =>
        `${JSON.stringify({ snapshotCommitSha: sha, operationId: "op-idempotent" }, null, 2)}\n`,
    });
    expect(first.pushCount).toBe(1);

    const second = await pushHarnessSnapshotViaLocalBareGit({
      bareRemotePath: remote.barePath,
      defaultBranch: remote.defaultBranch,
      expectedHeadSha: first.markerCommitSha,
      initializedCommitSha: remote.initializedCommitSha,
      snapshotRoot: fixture.snapshotRoot,
      manifest: fixture.manifest,
      operationId: "op-idempotent",
      packageVersion: fixture.manifest.packageVersion,
      existingSnapshotCommitSha: first.snapshotCommitSha,
      buildMarkerContent: (sha) =>
        `${JSON.stringify({ snapshotCommitSha: sha, operationId: "op-idempotent" }, null, 2)}\n`,
    });
    expect(second.markerCommitSha).toBe(first.markerCommitSha);
    expect(second.pushCount).toBe(0);
  }, 60_000);

  it("times out a stalled push within the configured bound and leaves remote recoverable", async () => {
    const fixture = await createRepresentativeBulkSnapshotFixture(32);
    trackTemp(fixture.packageRoot);
    const remote = createInitializedBareRemote();
    const timeoutMs = 2_500;
    const started = Date.now();
    await expect(
      pushHarnessSnapshotViaLocalBareGit({
        bareRemotePath: remote.barePath,
        defaultBranch: remote.defaultBranch,
        expectedHeadSha: remote.initializedCommitSha,
        initializedCommitSha: remote.initializedCommitSha,
        snapshotRoot: fixture.snapshotRoot,
        manifest: fixture.manifest,
        operationId: "op-timeout",
        packageVersion: fixture.manifest.packageVersion,
        timeoutMs,
        stallBeforePushMs: 20_000,
        buildMarkerContent: (sha) => `${sha}\n`,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof SnapshotProvisioningError &&
        error.code === "workspace-upload-timeout"
      );
    });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(15_000);

    const head = gitInBare(remote.barePath, ["rev-parse", remote.defaultBranch]);
    expect(head).toBe(remote.initializedCommitSha);

    const retry = await pushHarnessSnapshotViaLocalBareGit({
      bareRemotePath: remote.barePath,
      defaultBranch: remote.defaultBranch,
      expectedHeadSha: remote.initializedCommitSha,
      initializedCommitSha: remote.initializedCommitSha,
      snapshotRoot: fixture.snapshotRoot,
      manifest: fixture.manifest,
      operationId: "op-timeout",
      packageVersion: fixture.manifest.packageVersion,
      buildMarkerContent: (sha) => `${sha}\n`,
    });
    expect(retry.pushCount).toBe(1);
  }, 60_000);

  it("creates askpass credentials with restricted permissions and never embeds the token in argv", async () => {
    const token = "ghp_testtoken_bulk_transport_askpass_1234567890";
    const creds = await createGitAskpassCredentials(token);
    try {
      const tokenStat = statSync(creds.tokenPath);
      expect(tokenStat.mode & 0o777).toBe(0o600);
      const askpassStat = statSync(creds.askpassPath);
      expect(askpassStat.mode & 0o111).not.toBe(0);
      const tokenFile = await readFile(creds.tokenPath, "utf8");
      expect(tokenFile).toBe(token);
      expect(creds.env.GIT_ASKPASS).toBe(creds.askpassPath);
      expect(JSON.stringify(creds.env)).not.toContain(token);
    } finally {
      await creds.cleanup();
      expect(existsSync(creds.root)).toBe(false);
    }
  });

  it("does not create .git under a P_DEV_HOME workspace path", async () => {
    const home = trackTemp(mkdtempSync(path.join(tmpdir(), "p-dev-home-")));
    const fixture = await createRepresentativeBulkSnapshotFixture(32);
    trackTemp(fixture.packageRoot);
    const remote = createInitializedBareRemote();
    process.env.P_DEV_HOME = home;
    try {
      await pushHarnessSnapshotViaLocalBareGit({
        bareRemotePath: remote.barePath,
        defaultBranch: remote.defaultBranch,
        expectedHeadSha: remote.initializedCommitSha,
        initializedCommitSha: remote.initializedCommitSha,
        snapshotRoot: fixture.snapshotRoot,
        manifest: fixture.manifest,
        operationId: "op-no-home-git",
        packageVersion: fixture.manifest.packageVersion,
        buildMarkerContent: (sha) => `${sha}\n`,
      });
      expect(existsSync(path.join(home, ".git"))).toBe(false);
    } finally {
      delete process.env.P_DEV_HOME;
    }
  }, 60_000);
});

describe("harness provisioning progress persistence", () => {
  it("writes and reads redacted progress under .harness", async () => {
    const cwd = trackTemp(mkdtempSync(path.join(tmpdir(), "p-dev-progress-cwd-")));
    const {
      writeHarnessProvisioningProgressAtomic,
      readHarnessProvisioningProgress,
      loadHarnessProvisioningDiagnosticReport,
      clearHarnessProvisioningProgress,
    } = await import("../../src/setup/harness-provisioning-progress.js");

    await writeHarnessProvisioningProgressAtomic(
      {
        operationId: "op-progress-1",
        phase: "workspace-uploading",
        phaseStartedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        completed: 10,
        total: 100,
        lastSafeCheckpoint: "repository-created",
      },
      cwd,
    );
    const progress = await readHarnessProvisioningProgress(cwd);
    expect(progress?.operationId).toBe("op-progress-1");
    expect(progress?.uiPhase).toBe("uploading-workspace");
    expect(progress?.recoveryInstruction).toContain("op-progress-1");

    const report = await loadHarnessProvisioningDiagnosticReport({
      cwd,
      pending: {
        operationId: "op-progress-1",
        phase: "repository-created",
        repositoryId: 42,
        targetOwner: "weston-uribe",
        targetRepo: "p-dev-harness",
      },
    });
    expect(report.operationId).toBe("op-progress-1");
    expect(report.uiPhaseLabel).toBe("Uploading workspace");
    expect(JSON.stringify(report)).not.toMatch(/ghp_|token|GITHUB_/i);

    await clearHarnessProvisioningProgress(cwd);
    expect(await readHarnessProvisioningProgress(cwd)).toBeNull();
  });
});
