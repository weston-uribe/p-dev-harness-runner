import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fingerprintWorkspaceSnapshotManifest,
} from "../../src/p-dev/workspace-snapshot-manifest.js";
import type { WorkspaceSnapshotManifest } from "../../src/p-dev/workspace-snapshot-types.js";
import {
  buildHarnessSnapshotManagedRepoMarker,
  HARNESS_MANAGED_REPO_MARKER_FILE,
} from "../../src/setup/harness-managed-repo-marker.js";
import { deterministicMockRepositoryId } from "../../src/setup/github-remote-provider.js";
import {
  PrepareRunnerUpgradePullRequestError,
  prepareRunnerUpgradePullRequest,
} from "../../src/setup/prepare-runner-upgrade-pr.js";
import {
  buildRunnerUpgradeBranchNameForManifest,
  markerHasCompleteSnapshotCommitSha,
} from "../../src/setup/runner-upgrade-materialization.js";
import {
  readRunnerUpgradePendingState,
  writeRunnerUpgradePendingStateAtomic,
} from "../../src/setup/runner-upgrade-pending-state.js";
import { createMockRunnerUpgradeProvider } from "../../src/setup/runner-upgrade-provider.js";
import {
  buildRunnerUpgradePrMarker,
} from "../../src/setup/runner-upgrade-types.js";
import { createTestWorkspaceSnapshotRoot } from "./test-workspace-snapshot-fixture.js";

const REPO_SLUG = "owner/harness-repo";
const REPOSITORY_ID = deterministicMockRepositoryId(REPO_SLUG);
const README_V1 = "# runner v1\n";
const README_V2 = "# runner v2\n";

function sha256Content(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function manifestWithReadme(readme: string): WorkspaceSnapshotManifest {
  const sha256 = sha256Content(readme);
  return {
    schemaVersion: 1,
    product: "p-dev",
    role: "workspace-snapshot",
    packageName: "p-dev-harness",
    packageVersion: "0.3.1",
    sourceRepository: "weston-uribe/agentic-product-development-harness",
    sourceCommit: "cccccccccccccccccccccccccccccccccccccccc",
    snapshotContentId: `snap-${sha256.slice(0, 12)}`,
    snapshotSha256: `digest-${sha256.slice(0, 12)}`,
    gitRootTreeSha1: `tree-${sha256.slice(0, 12)}`,
    fileCount: 1,
    generation: {
      format: "p-dev-workspace-snapshot",
      version: 1,
      pathOrdering: "lexicographic",
      digestAlgorithm: "sha256",
      modeSource: "git",
      byteSource: "working-tree",
    },
    files: [
      {
        path: "README.md",
        type: "file",
        mode: "100644",
        size: Buffer.byteLength(readme, "utf8"),
        sha256,
        gitBlobSha1: `blob-${sha256.slice(0, 8)}`,
      },
    ],
  };
}

const FORBIDDEN_PROVIDER_METHODS = new Set([
  "mergePullRequest",
  "dispatchWorkflow",
  "writeHarnessSecrets",
  "writeHarnessVariables",
]);

const snapshotFixture = vi.hoisted(() => {
  const state = {
    snapshotRoot: "",
    packageRoot: "",
    manifest: null as WorkspaceSnapshotManifest | null,
    fingerprint: "",
  };
  return {
    get manifest() {
      return state.manifest;
    },
    set manifest(value: WorkspaceSnapshotManifest | null) {
      state.manifest = value;
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
    seed: async (manifest: WorkspaceSnapshotManifest) => {
      const fixture = await createTestWorkspaceSnapshotRoot(manifest.packageVersion);
      state.packageRoot = fixture.packageRoot;
      state.snapshotRoot = fixture.snapshotRoot;
      state.manifest = manifest;
      state.fingerprint = fingerprintWorkspaceSnapshotManifest(manifest);
      await writeFile(
        path.join(state.snapshotRoot, "manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
        "utf8",
      );
      await writeFile(path.join(state.snapshotRoot, "files", "README.md"), README_V2);
    },
  };
});

vi.mock("../../src/setup/harness-workspace-snapshot-loader.js", () => ({
  loadEmbeddedWorkspaceSnapshot: vi.fn(async () => snapshotFixture.load()),
  loadEmbeddedWorkspaceSnapshotIdentityForStatus: vi.fn(async () =>
    snapshotFixture.load(),
  ),
}));

function markerJson(
  manifest: WorkspaceSnapshotManifest,
  snapshotCommitSha = "remote-marker-commit",
): string {
  return `${JSON.stringify(
    buildHarnessSnapshotManagedRepoMarker({
      repository: REPO_SLUG,
      repositoryId: REPOSITORY_ID,
      manifest,
      snapshotCommitSha,
      defaultBranch: "main",
    }),
    null,
    2,
  )}\n`;
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
}) {
  const remoteMarker =
    input.remoteFiles?.[HARNESS_MANAGED_REPO_MARKER_FILE] ??
    markerJson(input.remoteManifest);
  const remoteFiles = {
    "README.md": README_V1,
    ...(input.remoteFiles ?? {}),
    [HARNESS_MANAGED_REPO_MARKER_FILE]: remoteMarker,
  };
  return createMockRunnerUpgradeProvider({
    repositories: {
      [REPO_SLUG]: {
        repositoryId: REPOSITORY_ID,
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

async function requiredBaseSha(provider: Awaited<ReturnType<typeof createProvider>>) {
  return provider.getRepositoryDefaultBranchHead("owner", "harness-repo", "main");
}

function assertNoForbiddenProviderCalls(
  provider: Awaited<ReturnType<typeof createProvider>>,
) {
  const forbidden = provider.calls.filter((call) =>
    FORBIDDEN_PROVIDER_METHODS.has(call.method),
  );
  expect(forbidden).toEqual([]);
}

describe("prepareRunnerUpgradePullRequest", () => {
  let workspaceDir = "";
  const v1Manifest = manifestWithReadme(README_V1);
  const v2Manifest = manifestWithReadme(README_V2);

  beforeEach(async () => {
    workspaceDir = await mkdtemp(path.join(tmpdir(), "prepare-runner-upgrade-"));
    await snapshotFixture.seed(v2Manifest);
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("materializes first prepare with complete marker identities and exact candidate head", async () => {
    const provider = await createProvider({ remoteManifest: v1Manifest });
    const baseSha = await requiredBaseSha(provider);

    const result = await prepareRunnerUpgradePullRequest(workspaceDir, provider, {
      repoSlug: REPO_SLUG,
      repositoryId: REPOSITORY_ID,
      requiredBaseSha: baseSha,
      operationId: "prepare-op-1",
    });

    expect(result.baseSha).toBe(baseSha);
    expect(result.branchName).toBe(
      buildRunnerUpgradeBranchNameForManifest(v2Manifest),
    );
    expect(result.prNumber).toBeGreaterThan(0);
    expect(result.prUrl).toContain(`/pull/${result.prNumber}`);
    expect(result.candidateHeadSha).toBe(result.markerCommitSha);
    expect(result.snapshotContentId).toBe(v2Manifest.snapshotContentId);
    expect(result.snapshotSha256).toBe(v2Manifest.snapshotSha256);
    expect(result.snapshotGitTreeSha1).toBe(v2Manifest.gitRootTreeSha1);
    expect(result.packagedSourceCommit).toBe(v2Manifest.sourceCommit);
    expect(result.completeIdentities.markerCommitSha).toBe(result.markerCommitSha);
    expect(result.completeIdentities.snapshotCommitSha).toBe(result.snapshotCommitSha);

    const markerRaw = await provider.readRepositoryFileContent(
      "owner",
      "harness-repo",
      HARNESS_MANAGED_REPO_MARKER_FILE,
      result.candidateHeadSha,
    );
    expect(markerRaw).toBeTruthy();
    const marker = JSON.parse(markerRaw!);
    expect(marker.createdFromPackageSnapshot.snapshotCommitSha).toBe(
      result.snapshotCommitSha,
    );
    expect(marker.createdFromPackageSnapshot.snapshotCommitSha).not.toBe("pending");
    expect(markerHasCompleteSnapshotCommitSha(marker)).toBe(true);

    const markerCommit = await provider.getGitCommit(
      "owner",
      "harness-repo",
      result.markerCommitSha,
    );
    expect(markerCommit.parents[0]?.sha).toBe(result.snapshotCommitSha);

    assertNoForbiddenProviderCalls(provider);
  });

  it("replays identically and adopts the same branch and PR", async () => {
    const provider = await createProvider({ remoteManifest: v1Manifest });
    const baseSha = await requiredBaseSha(provider);

    const first = await prepareRunnerUpgradePullRequest(workspaceDir, provider, {
      repoSlug: REPO_SLUG,
      repositoryId: REPOSITORY_ID,
      requiredBaseSha: baseSha,
      operationId: "prepare-op-1",
    });
    const callsAfterFirst = provider.calls.length;

    const second = await prepareRunnerUpgradePullRequest(workspaceDir, provider, {
      repoSlug: REPO_SLUG,
      repositoryId: REPOSITORY_ID,
      requiredBaseSha: baseSha,
      operationId: "prepare-op-2",
    });

    expect(second.branchName).toBe(first.branchName);
    expect(second.prNumber).toBe(first.prNumber);
    expect(second.prUrl).toBe(first.prUrl);
    expect(second.candidateHeadSha).toBe(first.candidateHeadSha);
    expect(
      provider.calls.slice(callsAfterFirst).filter((call) =>
        ["createGitBlob", "createGitTree", "createGitCommit", "createPullRequest"].includes(
          call.method,
        ),
      ),
    ).toEqual([]);
    assertNoForbiddenProviderCalls(provider);
  });

  it("fails closed on conflicting branch contents", async () => {
    const provider = await createProvider({ remoteManifest: v1Manifest });
    const baseSha = await requiredBaseSha(provider);
    const branchName = buildRunnerUpgradeBranchNameForManifest(v2Manifest);

    await provider.createGitRef({
      owner: "owner",
      repo: "harness-repo",
      ref: branchName,
      sha: baseSha,
    });

    await expect(
      prepareRunnerUpgradePullRequest(workspaceDir, provider, {
        repoSlug: REPO_SLUG,
        repositoryId: REPOSITORY_ID,
        requiredBaseSha: baseSha,
      }),
    ).rejects.toMatchObject({
      code: "conflicting_branch",
    } satisfies Partial<PrepareRunnerUpgradePullRequestError>);
    assertNoForbiddenProviderCalls(provider);
  });

  it("fails closed on conflicting PR head", async () => {
    const branchName = buildRunnerUpgradeBranchNameForManifest(v2Manifest);
    const provider = await createProvider({
      remoteManifest: v1Manifest,
      pullRequests: [
        {
          number: 9,
          htmlUrl: "https://github.com/owner/harness-repo/pull/9",
          headRef: branchName,
          baseRef: "main",
          body: buildRunnerUpgradePrMarker(REPOSITORY_ID, v2Manifest.snapshotContentId),
          state: "open",
          headSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        },
      ],
    });
    const baseSha = await requiredBaseSha(provider);

    await expect(
      prepareRunnerUpgradePullRequest(workspaceDir, provider, {
        repoSlug: REPO_SLUG,
        repositoryId: REPOSITORY_ID,
        requiredBaseSha: baseSha,
      }),
    ).rejects.toMatchObject({
      code: "conflicting_pr",
    } satisfies Partial<PrepareRunnerUpgradePullRequestError>);
    assertNoForbiddenProviderCalls(provider);
  });

  it("fails closed when main drifts during prepare", async () => {
    const provider = await createProvider({ remoteManifest: v1Manifest });
    const baseSha = await requiredBaseSha(provider);

    const originalCreateTree = provider.createGitTree.bind(provider);
    vi.spyOn(provider, "createGitTree").mockImplementation(async (input) => {
      provider.updateRemoteFile(
        REPO_SLUG,
        HARNESS_MANAGED_REPO_MARKER_FILE,
        markerJson(v1Manifest, "drifted-main-head-marker"),
        "main",
      );
      return originalCreateTree(input);
    });

    await expect(
      prepareRunnerUpgradePullRequest(workspaceDir, provider, {
        repoSlug: REPO_SLUG,
        repositoryId: REPOSITORY_ID,
        requiredBaseSha: baseSha,
      }),
    ).rejects.toMatchObject({
      code: "main_drift",
    } satisfies Partial<PrepareRunnerUpgradePullRequestError>);
    assertNoForbiddenProviderCalls(provider);
  });

  it("does not archive or clear unrelated pending upgrade state", async () => {
    const provider = await createProvider({ remoteManifest: v1Manifest });
    const baseSha = await requiredBaseSha(provider);
    await mkdir(path.join(workspaceDir, ".harness"), { recursive: true });
    await writeRunnerUpgradePendingStateAtomic(
      {
        operationId: "unrelated-pending-op",
        repositoryId: REPOSITORY_ID,
        repoSlug: REPO_SLUG,
        defaultBranch: "main",
        targetSnapshotContentId: v1Manifest.snapshotContentId,
        phase: "synchronizing-cloud-configuration",
        startedAt: new Date().toISOString(),
        previewFingerprint: "fp",
        syncInProgress: true,
        codeUpdateComplete: true,
        branchName: "harness/unrelated-branch",
        prUrl: "https://github.com/owner/harness-repo/pull/99",
      },
      workspaceDir,
    );

    await prepareRunnerUpgradePullRequest(workspaceDir, provider, {
      repoSlug: REPO_SLUG,
      repositoryId: REPOSITORY_ID,
      requiredBaseSha: baseSha,
    });

    const pending = await readRunnerUpgradePendingState(workspaceDir);
    expect(pending?.operationId).toBe("unrelated-pending-op");
    expect(pending?.phase).toBe("synchronizing-cloud-configuration");
    const archiveDir = path.join(workspaceDir, ".harness", "archive");
    await expect(readFile(archiveDir, "utf8")).rejects.toThrow();
    assertNoForbiddenProviderCalls(provider);
  });

  it("rejects when required base sha does not match main", async () => {
    const provider = await createProvider({ remoteManifest: v1Manifest });
    await expect(
      prepareRunnerUpgradePullRequest(workspaceDir, provider, {
        repoSlug: REPO_SLUG,
        repositoryId: REPOSITORY_ID,
        requiredBaseSha: "904107800e040f84d1a0368277cde98a2e21f1e2",
      }),
    ).rejects.toMatchObject({
      code: "main_baseline_mismatch",
    } satisfies Partial<PrepareRunnerUpgradePullRequestError>);
  });
});
