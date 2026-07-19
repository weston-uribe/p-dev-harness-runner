import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import {
  clearHarnessTestRunnerUpgradeProviderFactory,
  registerHarnessTestRunnerUpgradeProviderFactory,
} from "../../src/setup/test-only-runner-upgrade-provider.js";
import { createMockRunnerUpgradeProvider } from "../../src/setup/runner-upgrade-provider.js";
import {
  configureRunnerUpgradeWorker,
  resetRunnerUpgradeWorkerForTests,
  waitForRunnerUpgradeWorkerIdle,
} from "../../src/setup/runner-upgrade-worker.js";
import { executeRunnerUpgradeOperation } from "../../src/setup/runner-upgrade.js";
import { readRunnerUpgradePendingState } from "../../src/setup/runner-upgrade-pending-state.js";
import { createTestWorkspaceSnapshotRoot } from "../setup/test-workspace-snapshot-fixture.js";
import { createRunnerUpgradeCheckingSkeleton } from "../../apps/gui/lib/settings/runner-upgrade-ssr.js";
import {
  runnerUpgradeCanApply,
  runnerUpgradeCanPreview,
  runnerUpgradeRetryStatusVisible,
} from "../../apps/gui/lib/settings/runner-upgrade-ui-gates.js";
import { writeRunnerUpgradeLastVerifiedIdentity } from "../../src/setup/runner-upgrade-status-cache.js";
import { readRunnerUpgradeProgress } from "../../src/setup/runner-upgrade-progress.js";

vi.mock("server-only", () => ({}));

import { GET as statusRoute } from "../../apps/gui/app/api/setup/runner-upgrade-status/route.js";
import { POST as previewRoute } from "../../apps/gui/app/api/setup/preview-runner-upgrade/route.js";
import { POST as applyRoute } from "../../apps/gui/app/api/setup/apply-runner-upgrade/route.js";
import { GET as progressRoute } from "../../apps/gui/app/api/setup/runner-upgrade-progress/route.js";

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
}): WorkspaceSnapshotManifest {
  const gitBlobSha1 = computeGitBlobSha1(input.readme);
  return buildWorkspaceSnapshotManifest({
    packageVersion: input.packageVersion ?? "0.3.1",
    sourceCommit: "cccccccccccccccccccccccccccccccccccccccc",
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

describe("packaged runner upgrade Deployments routes", () => {
  let workspaceDir = "";
  let snapshotTempDir = "";
  let provider: Awaited<ReturnType<typeof createMockRunnerUpgradeProvider>>;
  const originalRepoRoot = process.env.HARNESS_REPO_ROOT;
  const originalRuntimeMode = process.env.P_DEV_RUNTIME_MODE;
  const originalTestSeam = process.env.HARNESS_VITEST_RUNNER_UPGRADE_MOCK;
  const originalStatusTestHooks =
    process.env.P_DEV_RUNNER_UPGRADE_STATUS_TEST_HOOKS;
  const v1Manifest = buildManifest({ readme: README_V1 });
  const v2Manifest = buildManifest({ readme: README_V2 });

  beforeEach(async () => {
    process.env.P_DEV_RUNTIME_MODE = "packaged";
    process.env.HARNESS_VITEST_RUNNER_UPGRADE_MOCK = "enabled";

    workspaceDir = await mkdtemp(path.join(tmpdir(), "packaged-runner-upgrade-"));
    process.env.HARNESS_REPO_ROOT = workspaceDir;
    await mkdir(path.join(workspaceDir, ".harness"), { recursive: true });
    await writeFile(
      path.join(workspaceDir, ".env.local"),
      [
        "GITHUB_TOKEN=ghp_test_token",
        "GITHUB_DISPATCH_REPOSITORY=owner/harness-repo",
        "HARNESS_CONFIG_PATH=.harness/config.local.json",
        "LINEAR_API_KEY=linear-test-key",
        "CURSOR_API_KEY=cursor-test-key",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(workspaceDir, ".harness", "config.local.json"),
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
    const { createHash } = await import("node:crypto");
    const configBytes = await (
      await import("node:fs/promises")
    ).readFile(path.join(workspaceDir, ".harness", "config.local.json"));
    const fingerprint = createHash("sha256").update(configBytes).digest("hex");
    await writeFile(
      path.join(workspaceDir, ".harness", "control-plane-setup.json"),
      `${JSON.stringify(
        {
          version: 1,
          initialSetup: {
            status: "complete",
            completedAt: "2026-01-01T00:00:00.000Z",
          },
          workflowModels: {
            configFingerprint: fingerprint,
            harnessRepository: REPO_SLUG,
            syncedAt: "2026-01-01T00:00:00.000Z",
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const fixture = await createTestWorkspaceSnapshotRoot("0.3.1");
    snapshotTempDir = fixture.packageRoot;
    snapshotFixture.packageRoot = fixture.packageRoot;
    snapshotFixture.snapshotRoot = fixture.snapshotRoot;
    snapshotFixture.manifest = v2Manifest;
    snapshotFixture.fingerprint = fingerprintWorkspaceSnapshotManifest(v2Manifest);
    await writeFile(
      path.join(snapshotFixture.snapshotRoot, "manifest.json"),
      `${JSON.stringify(v2Manifest, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      path.join(snapshotFixture.snapshotRoot, "files", "README.md"),
      README_V2,
    );

    const remoteMarker = markerJson(v1Manifest);
    provider = await createMockRunnerUpgradeProvider({
      canaryConclusion: "success",
      repositories: {
        [REPO_SLUG]: {
          repositoryId: deterministicMockRepositoryId(REPO_SLUG),
          owner: "owner",
          repo: "harness-repo",
          defaultBranch: "main",
          managedMarkerContent: remoteMarker,
          remoteFiles: {
            "README.md": README_V1.toString("utf8"),
            [HARNESS_MANAGED_REPO_MARKER_FILE]: remoteMarker,
          },
        },
      },
    });
    registerHarnessTestRunnerUpgradeProviderFactory(() => provider);
    configureRunnerUpgradeWorker({
      resolveProvider: async () => provider,
      execute: async (cwd, resolved) =>
        executeRunnerUpgradeOperation(cwd, resolved, {
          canaryPollIntervalMs: 1,
          canaryPollTimeoutMs: 50,
        }),
    });
  });

  afterEach(async () => {
    resetRunnerUpgradeWorkerForTests();
    clearHarnessTestRunnerUpgradeProviderFactory();
    if (originalRepoRoot === undefined) {
      delete process.env.HARNESS_REPO_ROOT;
    } else {
      process.env.HARNESS_REPO_ROOT = originalRepoRoot;
    }
    if (originalRuntimeMode === undefined) {
      delete process.env.P_DEV_RUNTIME_MODE;
    } else {
      process.env.P_DEV_RUNTIME_MODE = originalRuntimeMode;
    }
    if (originalTestSeam === undefined) {
      delete process.env.HARNESS_VITEST_RUNNER_UPGRADE_MOCK;
    } else {
      process.env.HARNESS_VITEST_RUNNER_UPGRADE_MOCK = originalTestSeam;
    }
    if (originalStatusTestHooks === undefined) {
      delete process.env.P_DEV_RUNNER_UPGRADE_STATUS_TEST_HOOKS;
    } else {
      process.env.P_DEV_RUNNER_UPGRADE_STATUS_TEST_HOOKS = originalStatusTestHooks;
    }
    await rm(workspaceDir, { recursive: true, force: true });
    if (snapshotTempDir) {
      await rm(snapshotTempDir, { recursive: true, force: true });
    }
  });

  it("status deadline hang: checking, retry, confirm-update, 202, blocked verify with zero mutations", async () => {
    process.env.P_DEV_RUNNER_UPGRADE_STATUS_TEST_HOOKS = "1";
    const localMarker = markerJson(v1Manifest);
    await writeFile(
      path.join(workspaceDir, HARNESS_MANAGED_REPO_MARKER_FILE),
      localMarker,
      "utf8",
    );
    await writeRunnerUpgradeLastVerifiedIdentity(
      {
        snapshotContentId: v1Manifest.snapshotContentId,
        packageVersion: v1Manifest.packageVersion,
        sourceCommit: v1Manifest.sourceCommit,
        verifiedAt: "2026-01-01T00:00:00.000Z",
        repoSlug: REPO_SLUG,
      },
      workspaceDir,
    );

    const started = Date.now();
    const hungStatusResponse = await statusRoute(
      new Request(
        "http://localhost/api/setup/runner-upgrade-status?debugTimings=1&testHangAfterStage=status_conversion&overallDeadlineMs=250",
      ),
    );
    const elapsed = Date.now() - started;
    expect(hungStatusResponse.status).toBe(200);
    expect(elapsed).toBeLessThan(2_000);
    const hungStatus = (await hungStatusResponse.json()) as {
      status: string;
      degraded?: boolean;
      retryAvailable?: boolean;
      localManagedRepoEvidence?: boolean;
      unresolvedStage?: string;
      currentSnapshotCached?: boolean;
      currentSnapshot?: { packageVersion: string };
      debugTimings?: Array<{ stage: string }>;
    };
    expect(hungStatus.status).toBe("checking");
    expect(hungStatus.degraded).toBe(true);
    expect(hungStatus.retryAvailable).toBe(true);
    expect(hungStatus.localManagedRepoEvidence).toBe(true);
    expect(hungStatus.unresolvedStage).toBe("status_conversion");
    expect(hungStatus.currentSnapshotCached).toBe(true);
    expect(hungStatus.currentSnapshot?.packageVersion).toBe("0.3.1");
    expect(runnerUpgradeRetryStatusVisible(hungStatus as never)).toBe(true);
    expect(
      runnerUpgradeCanApply({
        status: hungStatus as never,
        tokenUnavailable: false,
        lifecycleBusy: false,
      }),
    ).toBe(true);
    expect(
      runnerUpgradeCanPreview({
        status: hungStatus as never,
        tokenUnavailable: false,
        lifecycleBusy: false,
      }),
    ).toBe(false);

    const blockedProvider = await createMockRunnerUpgradeProvider({
      repositories: {
        [REPO_SLUG]: {
          repositoryId: deterministicMockRepositoryId(REPO_SLUG),
          owner: "owner",
          repo: "harness-repo",
          defaultBranch: "main",
          remoteFiles: {
            "README.md": README_V1.toString("utf8"),
          },
        },
      },
    });
    // Apply reconfigures the worker from the test factory — point it at the
    // non-managed remote so verification fails before any mutation.
    registerHarnessTestRunnerUpgradeProviderFactory(() => blockedProvider);

    const applyResponse = await applyRoute(
      new Request("http://localhost/api/setup/apply-runner-upgrade", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmed: true }),
      }),
    );
    expect(applyResponse.status).toBe(202);
    const applyBody = (await applyResponse.json()) as {
      apply: { status: string; operationId: string };
      progress: { operationId: string; phase: string };
    };
    expect(applyBody.apply.status).toBe("updating");
    expect(await readRunnerUpgradePendingState(workspaceDir)).toBeTruthy();
    expect(await readRunnerUpgradeProgress(workspaceDir)).toBeTruthy();
    expect(applyBody.progress.phase).toBe("verifying-managed-repository");

    const mutationMethods = new Set([
      "createGitBlob",
      "createGitTree",
      "createGitCommit",
      "createPullRequest",
      "updateGitRef",
      "createGitRef",
      "mergePullRequest",
      "writeHarnessSecrets",
      "writeHarnessVariables",
    ]);
    expect(
      blockedProvider.calls.filter((call) => mutationMethods.has(call.method)),
    ).toHaveLength(0);

    await waitForRunnerUpgradeWorkerIdle(30_000);

    expect(
      blockedProvider.calls.filter((call) => mutationMethods.has(call.method)),
    ).toHaveLength(0);

    const blockedStatusResponse = await statusRoute(
      new Request("http://localhost/api/setup/runner-upgrade-status"),
    );
    const blockedStatus = (await blockedStatusResponse.json()) as {
      status: string;
      blockedReason?: string;
    };
    expect(blockedStatus.status).toBe("blocked_non_managed");
    expect(blockedStatus.blockedReason).toBeTruthy();

    delete process.env.P_DEV_RUNNER_UPGRADE_STATUS_TEST_HOOKS;
  }, 60_000);

  it("detects update available, accepts apply with 202, resumes after sync failure", async () => {
    expect(createRunnerUpgradeCheckingSkeleton().status).toBe("checking");

    const statusResponse = await statusRoute(
      new Request("http://localhost/api/setup/runner-upgrade-status"),
    );
    expect(statusResponse.status).toBe(200);
    const statusBody = (await statusResponse.json()) as {
      status: string;
      currentSnapshot?: { snapshotContentId: string };
      availableSnapshot?: { snapshotContentId: string };
    };
    expect(statusBody.status).toBe("update_available");
    expect(statusBody.currentSnapshot?.snapshotContentId).toBe(
      v1Manifest.snapshotContentId,
    );
    expect(statusBody.availableSnapshot?.snapshotContentId).toBe(
      v2Manifest.snapshotContentId,
    );

    const previewResponse = await previewRoute(
      new Request("http://localhost/api/setup/preview-runner-upgrade", {
        method: "POST",
      }),
    );
    expect(previewResponse.status).toBe(200);
    const preview = (await previewResponse.json()) as {
      previewFingerprint: string;
      blocked?: boolean;
      impact: { replacePathCount: number };
    };
    expect(preview.blocked).toBeFalsy();
    expect(preview.previewFingerprint.length).toBeGreaterThan(0);
    expect(preview.impact.replacePathCount).toBeGreaterThan(0);

    provider.syncShouldFail = true;
    const failingApply = await applyRoute(
      new Request("http://localhost/api/setup/apply-runner-upgrade", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          confirmed: true,
          previewFingerprint: preview.previewFingerprint,
        }),
      }),
    );
    expect(failingApply.status).toBe(202);
    const failBody = (await failingApply.json()) as {
      apply: { status: string; operationId: string };
      status: { status: string };
      progress: { operationId: string; phase: string };
    };
    expect(failBody.apply.status).toBe("updating");
    expect(failBody.status.status).toBe("updating");
    expect(failBody.progress.phase).toBe("verifying-managed-repository");
    expect(await readRunnerUpgradePendingState(workspaceDir)).toBeTruthy();

    await waitForRunnerUpgradeWorkerIdle(30_000);

    const progressResponse = await progressRoute();
    expect(progressResponse.status).toBe(200);

    const failedStatus = await statusRoute(
      new Request("http://localhost/api/setup/runner-upgrade-status"),
    );
    const failedStatusBody = (await failedStatus.json()) as { status: string };
    expect(failedStatusBody.status).toBe("partially_updated");

    provider.syncShouldFail = false;
    provider.canaryConclusion = "success";
    const resumeApply = await applyRoute(
      new Request("http://localhost/api/setup/apply-runner-upgrade", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          confirmed: true,
          resume: true,
          previewFingerprint: preview.previewFingerprint,
        }),
      }),
    );
    expect(resumeApply.status).toBe(202);
    await waitForRunnerUpgradeWorkerIdle(30_000);

    const finalStatus = await statusRoute(
      new Request("http://localhost/api/setup/runner-upgrade-status"),
    );
    const finalBody = (await finalStatus.json()) as { status: string };
    expect(finalBody.status).toBe("up_to_date");

    const secretBeforeVariable = provider.remoteWriteOrder.indexOf("secret");
    const variableIndex = provider.remoteWriteOrder.indexOf("variable");
    expect(secretBeforeVariable).toBeGreaterThanOrEqual(0);
    expect(variableIndex).toBeGreaterThan(secretBeforeVariable);

    const linearCalls = provider.calls.filter((call) =>
      String(call.method).toLowerCase().includes("linear"),
    );
    const vercelCalls = provider.calls.filter((call) =>
      String(call.method).toLowerCase().includes("vercel"),
    );
    expect(linearCalls).toHaveLength(0);
    expect(vercelCalls).toHaveLength(0);
  }, 60_000);
});
