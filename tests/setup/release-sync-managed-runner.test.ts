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
import { createMockRunnerUpgradeProvider } from "../../src/setup/runner-upgrade-provider.js";
import { readRunnerUpgradePendingState } from "../../src/setup/runner-upgrade-pending-state.js";
import {
  RELEASE_SYNC_EXPECTED_REPOSITORY_ID,
  RELEASE_SYNC_EXPECTED_REPO_SLUG,
  ReleaseSyncManagedRunnerError,
  runReleaseSyncManagedRunner,
} from "../../src/setup/release-sync-managed-runner.js";
import { isRunnerUpgradeUiEnabled } from "../../apps/gui/lib/settings/runner-upgrade-feature-flag.js";
import { createTestWorkspaceSnapshotRoot } from "./test-workspace-snapshot-fixture.js";

const REPO_SLUG = RELEASE_SYNC_EXPECTED_REPO_SLUG;
const REPO_ID = RELEASE_SYNC_EXPECTED_REPOSITORY_ID;
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

function buildManifest(readme: Buffer): WorkspaceSnapshotManifest {
  const gitBlobSha1 = computeGitBlobSha1(readme);
  return buildWorkspaceSnapshotManifest({
    packageVersion: "0.3.1",
    sourceCommit: "cccccccccccccccccccccccccccccccccccccccc",
    entries: [
      {
        path: "README.md",
        type: "file",
        mode: "100644",
        size: readme.byteLength,
        content: readme,
        gitBlobSha1,
      },
    ],
  });
}

function markerJson(manifest: WorkspaceSnapshotManifest): string {
  return `${JSON.stringify(
    buildHarnessSnapshotManagedRepoMarker({
      repository: REPO_SLUG,
      repositoryId: REPO_ID,
      manifest,
      snapshotCommitSha: "remote-marker-commit",
      defaultBranch: "main",
    }),
    null,
    2,
  )}\n`;
}

async function writeWorkspace(root: string): Promise<void> {
  await mkdir(path.join(root, ".harness"), { recursive: true });
  await writeFile(
    path.join(root, ".env.local"),
    [
      "GITHUB_TOKEN=ghp_test_token",
      `GITHUB_DISPATCH_REPOSITORY=${REPO_SLUG}`,
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
            targetRepo: "https://github.com/weston-uribe/weston-uribe-portfolio",
            baseBranch: "main",
            productionBranch: "main",
          },
        ],
        allowedTargetRepos: [
          "https://github.com/weston-uribe/weston-uribe-portfolio",
        ],
        linear: { teamKey: "FRE" },
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

describe("release sync managed runner", () => {
  let workspaceDir = "";
  const v1Manifest = buildManifest(README_V1);
  const v2Manifest = buildManifest(README_V2);

  beforeEach(async () => {
    workspaceDir = await mkdtemp(path.join(tmpdir(), "release-sync-runner-"));
    await writeWorkspace(workspaceDir);
    const fixture = await createTestWorkspaceSnapshotRoot("0.3.1");
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
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("blocks wrong or unmanaged repository", async () => {
    const provider = await createMockRunnerUpgradeProvider({
      repositories: {
        "other/repo": {
          repositoryId: 999,
          owner: "other",
          repo: "repo",
          defaultBranch: "main",
          remoteFiles: { "README.md": "x" },
        },
      },
    });
    await expect(
      runReleaseSyncManagedRunner(provider, {
        cwd: workspaceDir,
        apply: true,
      }),
    ).rejects.toMatchObject({
      name: "ReleaseSyncManagedRunnerError",
      phase: "resolve_repository",
    });
  });

  it("blocks unexpected main changes via three-way compare", async () => {
    const remoteMarker = markerJson(v1Manifest);
    const provider = await createMockRunnerUpgradeProvider({
      repositories: {
        [REPO_SLUG]: {
          repositoryId: REPO_ID,
          owner: "weston-uribe",
          repo: "p-dev-harness",
          defaultBranch: "main",
          managedMarkerContent: remoteMarker,
          remoteFiles: {
            "README.md": "# operator edited remote\n",
            [HARNESS_MANAGED_REPO_MARKER_FILE]: remoteMarker,
          },
        },
      },
    });
    await expect(
      runReleaseSyncManagedRunner(provider, {
        cwd: workspaceDir,
        apply: true,
      }),
    ).rejects.toBeInstanceOf(ReleaseSyncManagedRunnerError);
  });

  it("upgrades the known managed snapshot, syncs secret+fingerprint, requires canary, and skips Linear/Cursor/Vercel", async () => {
    const remoteMarker = markerJson(v1Manifest);
    const provider = await createMockRunnerUpgradeProvider({
      canaryConclusion: "success",
      repositories: {
        [REPO_SLUG]: {
          repositoryId: REPO_ID,
          owner: "weston-uribe",
          repo: "p-dev-harness",
          defaultBranch: "main",
          managedMarkerContent: remoteMarker,
          remoteFiles: {
            "README.md": README_V1.toString("utf8"),
            [HARNESS_MANAGED_REPO_MARKER_FILE]: remoteMarker,
          },
        },
      },
    });

    const result = await runReleaseSyncManagedRunner(provider, {
      cwd: workspaceDir,
      apply: true,
    });
    expect(result.ok).toBe(true);
    expect(result.codeUpdateSkippedBecauseAlreadyCurrent).toBe(false);
    expect(result.canaryRunUrl).toBeTruthy();
    expect(provider.remoteWriteOrder).toEqual(["secret", "variable"]);
    const dispatchCall = provider.calls.find(
      (call) => call.method === "dispatchWorkflow",
    );
    expect(dispatchCall?.args[4]).toMatchObject({
      canary_operation_id: expect.any(String),
    });
    // Mock simulates GitHub 204: dispatch itself returns no run id; locate by op id.
    expect(
      provider.calls.some((call) => call.method === "listWorkflowRuns"),
    ).toBe(true);

    const forbidden = provider.calls.filter((call) => {
      const method = call.method.toLowerCase();
      return (
        method.includes("linear") ||
        method.includes("cursor") ||
        method.includes("vercel") ||
        method.includes("target")
      );
    });
    expect(forbidden).toHaveLength(0);
    expect(await readRunnerUpgradePendingState(workspaceDir)).toBeNull();
  }, 30_000);

  it("fails when canary does not pass", async () => {
    const remoteMarker = markerJson(v2Manifest);
    const provider = await createMockRunnerUpgradeProvider({
      canaryConclusion: "failure",
      repositories: {
        [REPO_SLUG]: {
          repositoryId: REPO_ID,
          owner: "weston-uribe",
          repo: "p-dev-harness",
          defaultBranch: "main",
          managedMarkerContent: remoteMarker,
          remoteFiles: {
            "README.md": README_V2.toString("utf8"),
            [HARNESS_MANAGED_REPO_MARKER_FILE]: remoteMarker,
          },
        },
      },
    });

    await expect(
      runReleaseSyncManagedRunner(provider, {
        cwd: workspaceDir,
        apply: true,
      }),
    ).rejects.toMatchObject({
      name: "ReleaseSyncManagedRunnerError",
      phase: "run_configuration_canary",
    });
    expect(provider.remoteWriteOrder).toEqual(["secret", "variable"]);
  }, 30_000);

  it("archives pending so automatic resume cannot continue", async () => {
    await writeFile(
      path.join(workspaceDir, ".harness", "p-dev-runner-upgrade.pending.json"),
      `${JSON.stringify(
        {
          operationId: "op-archive",
          repositoryId: REPO_ID,
          repoSlug: REPO_SLUG,
          defaultBranch: "main",
          targetSnapshotContentId: v2Manifest.snapshotContentId,
          phase: "running-configuration-canary",
          startedAt: new Date().toISOString(),
          previewFingerprint: "",
          syncInProgress: false,
          codeUpdateComplete: true,
          lastError: "Configuration canary failed with conclusion failure.",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const remoteMarker = markerJson(v2Manifest);
    const provider = await createMockRunnerUpgradeProvider({
      canaryConclusion: "success",
      repositories: {
        [REPO_SLUG]: {
          repositoryId: REPO_ID,
          owner: "weston-uribe",
          repo: "p-dev-harness",
          defaultBranch: "main",
          managedMarkerContent: remoteMarker,
          remoteFiles: {
            "README.md": README_V2.toString("utf8"),
            [HARNESS_MANAGED_REPO_MARKER_FILE]: remoteMarker,
          },
        },
      },
    });
    const result = await runReleaseSyncManagedRunner(provider, {
      cwd: workspaceDir,
      apply: true,
    });
    expect(result.cancel?.cancelled).toBe(true);
    expect(result.cancel?.archivedDir).toBeTruthy();
    expect(await readRunnerUpgradePendingState(workspaceDir)).toBeNull();
    const note = await readFile(
      path.join(result.cancel!.archivedDir!, "CANCELLED.md"),
      "utf8",
    );
    expect(note).toContain("op-archive");
  }, 30_000);

  it("keeps runner upgrade UI disabled unless feature flag is explicitly enabled", () => {
    expect(isRunnerUpgradeUiEnabled({})).toBe(false);
    expect(isRunnerUpgradeUiEnabled({ P_DEV_RUNNER_UPGRADE_UI_ENABLED: "0" })).toBe(
      false,
    );
    expect(isRunnerUpgradeUiEnabled({ P_DEV_RUNNER_UPGRADE_UI_ENABLED: "1" })).toBe(
      true,
    );
  });
});
