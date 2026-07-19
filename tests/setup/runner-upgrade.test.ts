import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeGitBlobSha1 } from "../../src/p-dev/git-object-plumbing.js";
import {
  buildWorkspaceSnapshotManifest,
  fingerprintWorkspaceSnapshotManifest,
} from "../../src/p-dev/workspace-snapshot-manifest.js";
import type { WorkspaceSnapshotManifest } from "../../src/p-dev/workspace-snapshot-types.js";
import {
  buildHarnessSnapshotManagedRepoMarker,
  HARNESS_MANAGED_REPO_MARKER_FILE,
} from "../../src/setup/harness-managed-repo-marker.js";
import { deterministicMockRepositoryId } from "../../src/setup/github-remote-provider.js";
import { readControlPlaneSetupState } from "../../src/setup/control-plane-setup-state.js";
import {
  buildRunnerUpgradeBranchName,
  buildRunnerUpgradePrMarker,
} from "../../src/setup/runner-upgrade-types.js";
import {
  readRunnerUpgradePendingState,
} from "../../src/setup/runner-upgrade-pending-state.js";
import { readRunnerUpgradeProgress } from "../../src/setup/runner-upgrade-progress.js";
import { createMockRunnerUpgradeProvider } from "../../src/setup/runner-upgrade-provider.js";
import {
  acceptRunnerUpgrade,
  applyRunnerUpgrade,
  executeRunnerUpgradeOperation,
  getLastRunnerUpgradeStatusCallTimings,
  loadRunnerUpgradeStatus,
  previewRunnerUpgrade,
  resumeRunnerUpgrade,
  RUNNER_UPGRADE_STATUS_PROVIDER_TIMEOUT_MS,
} from "../../src/setup/runner-upgrade.js";
import { writeRunnerUpgradeLastVerifiedIdentity } from "../../src/setup/runner-upgrade-status-cache.js";
import {
  abortInFlightRunnerUpgradeStatus,
  isRunnerUpgradeProgressStale,
  runnerUpgradeProgressShowsNoProgress,
  withRunnerUpgradeTimeout,
  RunnerUpgradeTimeoutError,
} from "../../src/setup/runner-upgrade-timeouts.js";
import { withHarnessRunnerUpgradeMutex } from "../../src/setup/runner-upgrade-pending-state.js";
import {
  configureRunnerUpgradeWorker,
  isRunnerUpgradeOperationActive,
  listActiveRunnerUpgradeOperationIds,
  resetRunnerUpgradeWorkerForTests,
  waitForRunnerUpgradeWorkerIdle,
} from "../../src/setup/runner-upgrade-worker.js";
import { createTestWorkspaceSnapshotRoot } from "./test-workspace-snapshot-fixture.js";

const REPO_SLUG = "owner/harness-repo";
const README_V1 = Buffer.from("# runner v1\n", "utf8");
const README_V2 = Buffer.from("# runner v2\n", "utf8");

const snapshotFixture = vi.hoisted(() => {
  const state = {
    snapshotRoot: "",
    packageRoot: "",
    manifest: null as WorkspaceSnapshotManifest | null,
    fingerprint: "",
  };
  return {
    get snapshotRoot() {
      return state.snapshotRoot;
    },
    set snapshotRoot(value: string) {
      state.snapshotRoot = value;
    },
    get packageRoot() {
      return state.packageRoot;
    },
    set packageRoot(value: string) {
      state.packageRoot = value;
    },
    get manifest() {
      return state.manifest;
    },
    set manifest(value: WorkspaceSnapshotManifest | null) {
      state.manifest = value;
    },
    get fingerprint() {
      return state.fingerprint;
    },
    set fingerprint(value: string) {
      state.fingerprint = value;
    },
    load: async () => {
      if (!state.manifest) {
        return {
          ok: false as const,
          state: "snapshot-unavailable" as const,
          message: "Test snapshot fixture is not initialized.",
        };
      }
      return {
        ok: true as const,
        packageRoot: state.packageRoot,
        snapshotRoot: state.snapshotRoot,
        packageVersion: state.manifest.packageVersion,
        manifest: state.manifest,
        fingerprint: state.fingerprint,
      };
    },
  };
});

vi.mock("../../src/setup/harness-workspace-snapshot-loader.js", () => ({
  loadEmbeddedWorkspaceSnapshot: vi.fn(async () => snapshotFixture.load()),
  loadEmbeddedWorkspaceSnapshotIdentityForStatus: vi.fn(async () =>
    snapshotFixture.load(),
  ),
}));

function buildManifest(input: {
  readme: Buffer;
  packageVersion?: string;
  sourceCommit?: string;
}): WorkspaceSnapshotManifest {
  const gitBlobSha1 = computeGitBlobSha1(input.readme);
  return buildWorkspaceSnapshotManifest({
    packageVersion: input.packageVersion ?? "0.3.1",
    sourceCommit: input.sourceCommit ?? "cccccccccccccccccccccccccccccccccccccccc",
    entries: [
      {
        path: "README.md",
        type: "file",
        mode: "100644",
        size: input.readme.byteLength,
        content: input.readme,
        gitBlobSha1,
      },
    ],
  });
}

function markerJson(manifest: WorkspaceSnapshotManifest): string {
  return `${JSON.stringify(
    buildHarnessSnapshotManagedRepoMarker({
      repository: REPO_SLUG,
      repositoryId: deterministicMockRepositoryId(REPO_SLUG),
      manifest,
      snapshotCommitSha: "remote-marker-commit",
      defaultBranch: "main",
    }),
    null,
    2,
  )}\n`;
}

async function writeWorkspaceEnv(root: string): Promise<void> {
  await mkdir(path.join(root, ".harness"), { recursive: true });
  await writeFile(
    path.join(root, ".env.local"),
    [
      "GITHUB_TOKEN=ghp_test_token",
      "GITHUB_DISPATCH_REPOSITORY=owner/harness-repo",
      "LINEAR_API_KEY=linear-test-key",
      "CURSOR_API_KEY=cursor-test-key",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(root, ".harness", "config.local.json"),
    `${JSON.stringify(
      {
        version: 1,
        orchestratorMarker: "harness-orchestrator-v1",
        logDirectory: "runs",
        repos: [
          {
            id: "target-app",
            targetRepo: "https://github.com/owner/example-target-app",
            baseBranch: "main",
            productionBranch: "main",
          },
        ],
        allowedTargetRepos: ["https://github.com/owner/example-target-app"],
        linear: { teamKey: "WES" },
        roleModels: {
          planner: { id: "composer-2.5" },
          builder: { id: "composer-2.5" },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function seedPackageSnapshot(manifest: WorkspaceSnapshotManifest): Promise<void> {
  const fixture = await createTestWorkspaceSnapshotRoot(manifest.packageVersion);
  snapshotFixture.packageRoot = fixture.packageRoot;
  snapshotFixture.snapshotRoot = fixture.snapshotRoot;
  snapshotFixture.manifest = manifest;
  snapshotFixture.fingerprint = fingerprintWorkspaceSnapshotManifest(manifest);
  await writeFile(
    path.join(snapshotFixture.snapshotRoot, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  await writeFile(path.join(snapshotFixture.snapshotRoot, "files", "README.md"), README_V2);
}

async function createProvider(input: {
  remoteManifest: WorkspaceSnapshotManifest;
  remoteFiles?: Record<string, string>;
  pullRequests?: Array<{
    number: number;
    htmlUrl: string;
    headRef: string;
    baseRef: string;
    body: string;
    state: "open" | "closed";
    headSha: string;
  }>;
  syncShouldFail?: boolean;
  canaryConclusion?: "success" | "failure";
}) {
  const remoteMarker =
    input.remoteFiles?.[HARNESS_MANAGED_REPO_MARKER_FILE] ?? markerJson(input.remoteManifest);
  const remoteFiles = {
    "README.md": README_V1.toString("utf8"),
    ...(input.remoteFiles ?? {}),
    [HARNESS_MANAGED_REPO_MARKER_FILE]: remoteMarker,
  };
  return createMockRunnerUpgradeProvider({
    syncShouldFail: input.syncShouldFail,
    canaryConclusion: input.canaryConclusion,
    repositories: {
      [REPO_SLUG]: {
        repositoryId: deterministicMockRepositoryId(REPO_SLUG),
        owner: "owner",
        repo: "harness-repo",
        defaultBranch: "main",
        managedMarkerContent: remoteMarker,
        remoteFiles,
        pullRequests: input.pullRequests,
      },
    },
  });
}

describe("runner upgrade orchestration", () => {
  let workspaceDir = "";
  const v1Manifest = buildManifest({ readme: README_V1 });
  const v2Manifest = buildManifest({ readme: README_V2 });

  beforeEach(async () => {
    workspaceDir = await mkdtemp(path.join(tmpdir(), "runner-upgrade-"));
    await writeWorkspaceEnv(workspaceDir);
    await seedPackageSnapshot(v2Manifest);
  });

  afterEach(async () => {
    resetRunnerUpgradeWorkerForTests();
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("reports update available when remote snapshot is older than package", async () => {
    const provider = await createProvider({ remoteManifest: v1Manifest });
    const status = await loadRunnerUpgradeStatus(workspaceDir, provider);
    expect(status.status).toBe("update_available");
    expect(status.currentSnapshot?.snapshotContentId).toBe(v1Manifest.snapshotContentId);
    expect(status.availableSnapshot?.snapshotContentId).toBe(v2Manifest.snapshotContentId);
  });

  it("reports up to date when remote snapshot matches package", async () => {
    const provider = await createProvider({ remoteManifest: v2Manifest });
    const status = await loadRunnerUpgradeStatus(workspaceDir, provider);
    expect(status.status).toBe("up_to_date");
  });

  it("blocks non-managed repositories without snapshot marker provenance", async () => {
    const provider = await createProvider({
      remoteManifest: v1Manifest,
      remoteFiles: {
        [HARNESS_MANAGED_REPO_MARKER_FILE]: `${JSON.stringify({ invalid: true })}\n`,
      },
    });
    const status = await loadRunnerUpgradeStatus(workspaceDir, provider);
    expect(status.status).toBe("blocked_non_managed");
  });

  it("blocks preview when operator edits conflict with packaged upgrade", async () => {
    const provider = await createProvider({
      remoteManifest: v1Manifest,
      remoteFiles: {
        "README.md": "# operator edited\n",
      },
    });
    const preview = await previewRunnerUpgrade(workspaceDir, provider);
    expect(preview.blocked).toBe(true);
    expect(preview.blockedStatus).toBe("blocked_operator_conflicts");
    expect(preview.conflictPaths).toContain("README.md");
  });

  it("reuses an open snapshot-keyed PR after local pending state was cleared", async () => {
    const branchName = buildRunnerUpgradeBranchName(v2Manifest.snapshotContentId);
    const provider = await createProvider({
      remoteManifest: v1Manifest,
      pullRequests: [
        {
          number: 7,
          htmlUrl: "https://github.com/owner/harness-repo/pull/7",
          headRef: branchName,
          baseRef: "main",
          body: buildRunnerUpgradePrMarker(
            deterministicMockRepositoryId(REPO_SLUG),
            v2Manifest.snapshotContentId,
          ),
          state: "open",
          headSha: "existing-head-sha",
        },
      ],
    });

    const preview = await previewRunnerUpgrade(workspaceDir, provider);
    const result = await applyRunnerUpgrade(workspaceDir, provider, {
      previewFingerprint: preview.previewFingerprint,
      canaryPollIntervalMs: 1,
      canaryPollTimeoutMs: 50,
    });

    expect(result.status).toBe("up_to_date");
    expect(
      provider.calls.filter((call) => call.method === "createPullRequest"),
    ).toHaveLength(0);
    expect(
      provider.calls.some((call) => call.method === "mergePullRequest"),
    ).toBe(true);
  });

  it("returns partially_updated when cloud sync fails and resumes from sync phase", async () => {
    const provider = await createProvider({
      remoteManifest: v1Manifest,
      syncShouldFail: true,
    });
    const preview = await previewRunnerUpgrade(workspaceDir, provider);
    const failed = await applyRunnerUpgrade(workspaceDir, provider, {
      previewFingerprint: preview.previewFingerprint,
      canaryPollIntervalMs: 1,
      canaryPollTimeoutMs: 50,
    });
    expect(failed.status).toBe("partially_updated");
    expect(failed.phase).toBe("synchronizing-cloud-configuration");

    const pending = await readRunnerUpgradePendingState(workspaceDir);
    expect(pending?.codeUpdateComplete).toBe(true);

    const resumeProvider = await createProvider({ remoteManifest: v2Manifest });
    const resumed = await resumeRunnerUpgrade(workspaceDir, resumeProvider, {
      canaryPollIntervalMs: 1,
      canaryPollTimeoutMs: 50,
    });
    expect(resumed.status).toBe("up_to_date");
    expect(
      resumeProvider.calls.some((call) => call.method === "createPullRequest"),
    ).toBe(false);
  });

  it("completes upgrade through canary success and records control-plane evidence", async () => {
    const provider = await createProvider({
      remoteManifest: v1Manifest,
      canaryConclusion: "success",
    });
    const preview = await previewRunnerUpgrade(workspaceDir, provider);
    const result = await applyRunnerUpgrade(workspaceDir, provider, {
      previewFingerprint: preview.previewFingerprint,
      canaryPollIntervalMs: 1,
      canaryPollTimeoutMs: 50,
    });

    expect(result.status).toBe("up_to_date");
    expect(result.canaryRunUrl).toContain("/actions/runs/");

    const setupState = await readControlPlaneSetupState(workspaceDir);
    expect(setupState?.runnerUpgrade?.status).toBe("up_to_date");
    expect(setupState?.runnerUpgrade?.appliedSnapshotContentId).toBe(
      v2Manifest.snapshotContentId,
    );

    const pendingPath = path.join(
      workspaceDir,
      ".harness",
      "p-dev-runner-upgrade.pending.json",
    );
    await expect(readFile(pendingPath, "utf8")).rejects.toThrow();
  });

  it("writes cloud secrets before fingerprint variable during sync", async () => {
    const provider = await createProvider({ remoteManifest: v1Manifest });
    const preview = await previewRunnerUpgrade(workspaceDir, provider);
    await applyRunnerUpgrade(workspaceDir, provider, {
      previewFingerprint: preview.previewFingerprint,
      canaryPollIntervalMs: 1,
      canaryPollTimeoutMs: 50,
    });
    expect(provider.remoteWriteOrder).toEqual(["secret", "variable"]);
  });

  it("keeps pending operation id across resume", async () => {
    const provider = await createProvider({
      remoteManifest: v1Manifest,
      syncShouldFail: true,
    });
    const preview = await previewRunnerUpgrade(workspaceDir, provider);
    await applyRunnerUpgrade(workspaceDir, provider, {
      previewFingerprint: preview.previewFingerprint,
      canaryPollIntervalMs: 1,
      canaryPollTimeoutMs: 50,
    });
    const pendingBefore = await readRunnerUpgradePendingState(workspaceDir);
    expect(pendingBefore?.operationId).toBeTruthy();
    expect(pendingBefore?.codeUpdateComplete).toBe(true);

    const resumeProvider = await createProvider({ remoteManifest: v2Manifest });
    await resumeRunnerUpgrade(workspaceDir, resumeProvider, {
      canaryPollIntervalMs: 1,
      canaryPollTimeoutMs: 50,
    });
    const pendingAfter = await readRunnerUpgradePendingState(workspaceDir);
    expect(pendingAfter).toBeNull();
  });

  it("returns checking when status provider calls exceed the status budget", async () => {
    const provider = await createProvider({ remoteManifest: v1Manifest });
    provider.methodDelayMs = {
      readRepositoryFileContent:
        RUNNER_UPGRADE_STATUS_PROVIDER_TIMEOUT_MS + 200,
    };
    const started = Date.now();
    const status = await loadRunnerUpgradeStatus(workspaceDir, provider);
    const elapsed = Date.now() - started;
    expect(status.status).toBe("checking");
    expect(status.degraded).toBe(true);
    expect(elapsed).toBeLessThan(RUNNER_UPGRADE_STATUS_PROVIDER_TIMEOUT_MS + 2_500);
    const timings = getLastRunnerUpgradeStatusCallTimings();
    expect(timings.some((entry) => entry.timedOut || entry.call === "readRemoteManagedMarker")).toBe(
      true,
    );
  }, 20_000);

  it("absolute deadline returns checking when a later internal stage never resolves", async () => {
    const provider = await createProvider({ remoteManifest: v1Manifest });
    const started = Date.now();
    const status = await loadRunnerUpgradeStatus(workspaceDir, provider, {
      testHangAfterStage: "status_conversion",
      overallDeadlineMs: 200,
      debugTimings: true,
      workspaceKey: `${workspaceDir}-deadline`,
    });
    const elapsed = Date.now() - started;
    expect(status.status).toBe("checking");
    expect(status.degraded).toBe(true);
    expect(status.retryAvailable).toBe(true);
    expect(status.unresolvedStage).toBe("status_conversion");
    expect(elapsed).toBeLessThan(1_500);
  }, 10_000);

  it("timeout wrapper does not await abandoned work", async () => {
    let abandonedStillRunning = true;
    const started = Date.now();
    await expect(
      withRunnerUpgradeTimeout("never-settle", 80, async (signal) => {
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              abandonedStillRunning = false;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
      }),
    ).rejects.toBeInstanceOf(RunnerUpgradeTimeoutError);
    expect(Date.now() - started).toBeLessThan(500);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(abandonedStillRunning).toBe(false);
  });

  it("second status request aborts the previous in-flight status op", async () => {
    const provider = await createProvider({ remoteManifest: v1Manifest });
    const key = `${workspaceDir}-abort-prev`;
    const first = loadRunnerUpgradeStatus(workspaceDir, provider, {
      testHangAfterStage: "provider_wrapper",
      overallDeadlineMs: 5_000,
      workspaceKey: key,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    abortInFlightRunnerUpgradeStatus(key);
    const second = await loadRunnerUpgradeStatus(workspaceDir, provider, {
      overallDeadlineMs: 2_000,
      workspaceKey: key,
    });
    expect(second.status === "update_available" || second.status === "checking").toBe(
      true,
    );
    const firstResult = await first;
    expect(firstResult.status).toBe("checking");
  }, 15_000);

  it("status does not wait for a held upgrade mutex", async () => {
    const provider = await createProvider({ remoteManifest: v1Manifest });
    let releaseMutex!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseMutex = resolve;
    });
    const mutexHolder = withHarnessRunnerUpgradeMutex(workspaceDir, async () => {
      await held;
    });
    const started = Date.now();
    const status = await loadRunnerUpgradeStatus(workspaceDir, provider, {
      overallDeadlineMs: 2_000,
      workspaceKey: `${workspaceDir}-mutex`,
    });
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(["update_available", "checking", "up_to_date"]).toContain(status.status);
    releaseMutex();
    await mutexHolder;
  }, 15_000);

  it("preserves cached last-verified identity across checking timeout", async () => {
    const provider = await createProvider({ remoteManifest: v1Manifest });
    await writeRunnerUpgradeLastVerifiedIdentity(
      {
        snapshotContentId: v1Manifest.snapshotContentId,
        packageVersion: "0.3.1",
        sourceCommit: v1Manifest.sourceCommit,
        verifiedAt: "2026-01-02T00:00:00.000Z",
        repoSlug: REPO_SLUG,
      },
      workspaceDir,
    );
    const status = await loadRunnerUpgradeStatus(workspaceDir, provider, {
      testHangAfterStage: "status_conversion",
      overallDeadlineMs: 150,
      workspaceKey: `${workspaceDir}-cache`,
    });
    expect(status.status).toBe("checking");
    expect(status.currentSnapshotCached).toBe(true);
    expect(status.currentSnapshot?.packageVersion).toBe("0.3.1");
    expect(status.currentSnapshotVerifiedAt).toBe("2026-01-02T00:00:00.000Z");
  }, 10_000);

  it("worker blocks before mutation when remote verification fails", async () => {
    await writeFile(
      path.join(workspaceDir, HARNESS_MANAGED_REPO_MARKER_FILE),
      markerJson(v1Manifest),
      "utf8",
    );
    const blockedProvider = await createMockRunnerUpgradeProvider({
      repositories: {
        [REPO_SLUG]: {
          repositoryId: deterministicMockRepositoryId(REPO_SLUG),
          owner: "owner",
          repo: "harness-repo",
          defaultBranch: "main",
          remoteFiles: { "README.md": README_V1.toString("utf8") },
        },
      },
    });
    configureRunnerUpgradeWorker({
      resolveProvider: async () => blockedProvider,
      execute: async (cwd, resolved) =>
        executeRunnerUpgradeOperation(cwd, resolved, {
          canaryPollIntervalMs: 1,
          canaryPollTimeoutMs: 50,
        }),
    });
    const accepted = await acceptRunnerUpgrade(workspaceDir, {});
    expect(await readRunnerUpgradePendingState(workspaceDir)).toBeTruthy();
    await waitForRunnerUpgradeWorkerIdle(15_000);
    const mutationMethods = new Set([
      "createGitBlob",
      "createGitTree",
      "createGitCommit",
      "createPullRequest",
      "updateGitRef",
    ]);
    expect(
      blockedProvider.calls.filter((call) => mutationMethods.has(call.method)),
    ).toHaveLength(0);
    const status = await loadRunnerUpgradeStatus(workspaceDir, blockedProvider);
    expect(status.status).toBe("blocked_non_managed");
    expect(status.blockedReason).toBeTruthy();
    expect(accepted.apply.operationId).toBeTruthy();
  }, 30_000);

  it("accepts upgrade before any remote provider call and worker completes", async () => {
    const provider = await createProvider({ remoteManifest: v1Manifest });
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    configureRunnerUpgradeWorker({
      resolveProvider: async () => {
        await providerGate;
        return provider;
      },
      execute: async (cwd, resolvedProvider) =>
        executeRunnerUpgradeOperation(cwd, resolvedProvider, {
          canaryPollIntervalMs: 1,
          canaryPollTimeoutMs: 50,
        }),
    });

    const accepted = await acceptRunnerUpgrade(workspaceDir, {});
    expect(accepted.apply.status).toBe("updating");
    expect(accepted.apply.operationId).toBeTruthy();
    expect(accepted.progress.phase).toBe("verifying-managed-repository");
    expect(provider.calls.length).toBe(0);

    const pending = await readRunnerUpgradePendingState(workspaceDir);
    const progress = await readRunnerUpgradeProgress(workspaceDir);
    expect(pending?.operationId).toBe(accepted.apply.operationId);
    expect(progress?.operationId).toBe(accepted.apply.operationId);

    releaseProvider();
    await waitForRunnerUpgradeWorkerIdle(30_000);
    const status = await loadRunnerUpgradeStatus(workspaceDir, provider);
    expect(status.status).toBe("up_to_date");
  }, 40_000);

  it("does not start duplicate workers for the same operation id", async () => {
    const provider = await createProvider({ remoteManifest: v1Manifest });
    let executions = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    configureRunnerUpgradeWorker({
      resolveProvider: async () => provider,
      execute: async () => {
        executions += 1;
        await firstGate;
      },
    });
    const accepted = await acceptRunnerUpgrade(workspaceDir, {});
    await acceptRunnerUpgrade(workspaceDir, {
      resume: true,
    });
    expect(isRunnerUpgradeOperationActive(accepted.apply.operationId)).toBe(true);
    releaseFirst();
    await waitForRunnerUpgradeWorkerIdle(10_000);
    expect(executions).toBe(1);
    expect(listActiveRunnerUpgradeOperationIds()).toHaveLength(0);
  });

  it("returns pending status from disk without GitHub when upgrade is in flight", async () => {
    const provider = await createProvider({ remoteManifest: v1Manifest });
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    configureRunnerUpgradeWorker({
      resolveProvider: async () => {
        await providerGate;
        return provider;
      },
      execute: async () => undefined,
    });
    await acceptRunnerUpgrade(workspaceDir, {});
    const before = provider.calls.length;
    const status = await loadRunnerUpgradeStatus(workspaceDir, provider);
    expect(status.status).toBe("updating");
    expect(provider.calls.length).toBe(before);
    releaseProvider();
    await waitForRunnerUpgradeWorkerIdle(5_000);
  });

  it("treats no-progress only when updatedAt and heartbeat are both stale", () => {
    const now = Date.now();
    expect(
      isRunnerUpgradeProgressStale({
        updatedAt: new Date(now - 60_000).toISOString(),
        workerHeartbeatAt: new Date(now - 1_000).toISOString(),
        nowMs: now,
        staleMs: 30_000,
      }),
    ).toBe(false);
    expect(
      runnerUpgradeProgressShowsNoProgress({
        operationId: "op",
        phase: "comparing-runner-snapshots",
        uiPhase: "comparing-runner-snapshots",
        uiPhaseLabel: "Comparing runner snapshots",
        phaseStartedAt: new Date(now - 120_000).toISOString(),
        startedAt: new Date(now - 120_000).toISOString(),
        elapsedMs: 120_000,
        recoveryInstruction: "retry",
        updatedAt: new Date(now - 60_000).toISOString(),
        workerHeartbeatAt: new Date(now - 60_000).toISOString(),
        lastSuccessfulProviderCallAt: new Date(now - 60_000).toISOString(),
      }, now),
    ).toBe(true);
  });
});
